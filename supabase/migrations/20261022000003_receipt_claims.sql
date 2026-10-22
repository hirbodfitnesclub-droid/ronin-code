-- Ronin Code — receipt-photo claims (migration 3)
--
-- Owner decision (2026-10-22), superseding the Liro form-field claim that
-- migrations 1–2 implemented: a card-to-card claim is now ONE receipt photo
-- and nothing else. The payer reviews every receipt image personally in the
-- admin panel, so the claim carries no typed fields at all:
--   orders.receipt_path   — object key in the PRIVATE Storage bucket `receipts`
--   orders.image_sha256   — SHA-256 of the uploaded bytes (duplicate flag)
-- The legacy form columns (payer_name, card_last4, reference, paid_at_text)
-- are dropped. approve_claim / reject_claim are untouched: still one atomic,
-- idempotent transaction; a second review conflicts; approve writes
-- credit + ledger + audit, reject stores a user-visible reason.

alter table public.orders
  add column if not exists receipt_path text,
  add column if not exists image_sha256 text;

alter table public.orders
  drop column if exists payer_name,
  drop column if exists card_last4,
  drop column if exists reference,
  drop column if exists paid_at_text;

create index if not exists idx_orders_image_sha
  on public.orders (image_sha256) where image_sha256 is not null;

-- ── create_claim: new signature (receipt instead of form fields) ────────────
-- The old 9-argument overload must go explicitly, otherwise both would exist.
drop function if exists public.create_claim(uuid, text, text, bigint, bigint, text, text, text, text);

create or replace function public.create_claim(
  p_user_id uuid, p_pack_id text, p_pack_title text, p_tokens bigint,
  p_price_rials bigint, p_receipt_path text, p_image_sha256 text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pending integer; v_order public.orders;
begin
  if p_receipt_path is null or length(trim(p_receipt_path)) = 0
     or p_image_sha256 is null or length(trim(p_image_sha256)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'receipt_required');
  end if;
  perform 1 from public.users where id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;
  select count(*) into v_pending from public.orders
  where user_id = p_user_id and status = 'pending';
  if v_pending >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_pending');
  end if;
  insert into public.orders (user_id, pack_id, pack_title, tokens, price_rials,
    receipt_path, image_sha256)
  values (p_user_id, p_pack_id, p_pack_title, p_tokens, p_price_rials,
    p_receipt_path, p_image_sha256)
  returning * into v_order;
  return jsonb_build_object('ok', true, 'order', to_jsonb(v_order));
end;
$$;

-- New function ⇒ default PUBLIC execute; lock it down like migration 2 did.
revoke execute on function
  public.create_claim(uuid, text, text, bigint, bigint, text, text)
  from public;
grant execute on function
  public.create_claim(uuid, text, text, bigint, bigint, text, text)
  to service_role;

-- ── Storage: private `receipts` bucket + policies ───────────────────────────
-- Real Supabase projects ship the `storage` schema; the local dev stack
-- (plain embedded Postgres) does not, so this block is a no-op there — the
-- local server stores receipts on disk through the same object-key contract
-- (see server/src/storage.js). On Supabase:
--   * bucket `receipts` is PRIVATE (public = false ⇒ no anonymous reads);
--   * authenticated users may INSERT only under their own uid/ prefix
--     (defense in depth — the API server uploads with the service role);
--   * NO select/update/delete policy for anon/authenticated: reads happen
--     exclusively through service-role signed URLs minted for admins.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables
                 where table_schema = 'storage' and table_name = 'buckets')
     and exists (select 1 from information_schema.tables
                 where table_schema = 'storage' and table_name = 'objects') then
    insert into storage.buckets (id, name, public)
    values ('receipts', 'receipts', false)
    on conflict (id) do nothing;

    execute 'drop policy if exists receipts_insert_own on storage.objects';
    execute $pol$
      create policy receipts_insert_own on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'receipts'
          and (storage.foldername(name))[1] = (select auth.uid())::text
        )
    $pol$;
  end if;
end $$;
