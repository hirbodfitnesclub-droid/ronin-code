-- Ronin Code — admin panel additions (migration 3)
--
-- Added on branch panel/admin-web for the React admin console (PRD §6):
--   * Receipt-only card-to-card claims: orders gain receipt_path/receipt_sha256.
--     NOTE (merge flag): the receipt rework was still in flight on
--     supabase-migration when this branch forked, so the claim side here is
--     ADDITIVE — the legacy form-field columns stay (nullable use continues);
--     this migration only adds what the admin review queue needs: the receipt
--     object key (private `receipts` storage bucket), its SHA-256 for the
--     passive duplicate flag, and refund accumulators.
--   * Refunds: public.order_refunds + public.refund_order RPC (atomic,
--     idempotent, proportional token removal, never below zero) — Liro shape.
--   * Finance console: public.expenses + public.finance_periods (P&L is a
--     read model over orders/order_refunds/expenses — no extra tables).
--   * Risk flags: public.risk_flags for the user dossier.
-- Money still moves ONLY inside SECURITY DEFINER RPCs; new tables are
-- service-role only (RLS on, no end-user policies), exactly like the rest.

-- ── Orders: receipts + refund accumulators ─────────────────────────────────
alter table public.orders add column if not exists receipt_path text;
alter table public.orders add column if not exists receipt_sha256 text;
alter table public.orders add column if not exists refunded_amount_rials bigint not null default 0;
alter table public.orders add column if not exists refunded_tokens bigint not null default 0;
create index if not exists idx_orders_receipt_sha on public.orders (receipt_sha256) where receipt_sha256 is not null;

-- Full refund flips an approved order to 'refunded' (Liro: partial refunds
-- keep status 'approved' and only accumulate the refunded_* columns).
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending', 'approved', 'rejected', 'refunded'));

-- ── Ledger: allow the 'refund' kind ─────────────────────────────────────────
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check
  check (kind in ('purchase', 'consume', 'hold', 'release', 'adjust', 'expire', 'refund'));

-- ── Refunds (Liro payment_refunds shape) ────────────────────────────────────
create table if not exists public.order_refunds (
  id              bigint generated always as identity primary key,
  order_id        bigint not null references public.orders (id) on delete cascade,
  user_id         uuid not null references public.users (id) on delete cascade,
  amount_rials    bigint not null check (amount_rials > 0),
  tokens_removed  bigint not null default 0,
  reason          text not null,
  reference       text,
  actor           text not null,               -- admin phone
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);
create index if not exists idx_refunds_order on public.order_refunds (order_id, created_at);
create index if not exists idx_refunds_created on public.order_refunds (created_at);

-- ── Finance: expenses + periods ─────────────────────────────────────────────
create table if not exists public.expenses (
  id           bigint generated always as identity primary key,
  amount_rials bigint not null check (amount_rials > 0),
  category     text not null,
  note         text,
  spent_on     date not null default current_date,
  actor        text not null,                  -- admin phone who recorded it
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_expenses_spent on public.expenses (spent_on);

create table if not exists public.finance_periods (
  id         bigint generated always as identity primary key,
  title      text not null,
  starts_on  date not null,
  ends_on    date not null check (ends_on >= starts_on),
  closed_at  timestamptz,
  closed_by  text,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- ── Risk flags (user dossier) ───────────────────────────────────────────────
create table if not exists public.risk_flags (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  kind        text not null,                   -- e.g. sharing_suspected | farming | chargeback | other
  note        text,
  status      text not null default 'open' check (status in ('open', 'resolved')),
  created_by  text not null,                   -- admin phone
  created_at  timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz
);
create index if not exists idx_risk_flags_user on public.risk_flags (user_id, status);

-- ── RLS + privileges (service role only, like every server-side table) ─────
alter table public.order_refunds   enable row level security;
alter table public.expenses        enable row level security;
alter table public.finance_periods enable row level security;
alter table public.risk_flags      enable row level security;
revoke all on public.order_refunds, public.expenses, public.finance_periods, public.risk_flags from anon, authenticated;
grant all on public.order_refunds, public.expenses, public.finance_periods, public.risk_flags to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── RPC: refund an approved order ───────────────────────────────────────────
-- The owner returns the money OUTSIDE the system (bank transfer), then records
-- the refund here (Liro refundPayment semantics):
--   * order must be 'approved' (a fully-refunded order rejects more refunds);
--   * amount_rials > 0 and cumulative refunds never exceed the amount actually
--     received for the order (falling back to the pack price snapshot);
--   * tokens are removed proportionally (amount / price × pack tokens),
--     capped at the not-yet-refunded tokens AND at the user's balance
--     (a balance can never go below zero);
--   * idempotent on p_idempotency_key: a replay returns the original refund
--     with replayed=true and moves nothing;
--   * ledger 'refund' entry + admin_audit row, all in one transaction.
create or replace function public.refund_order(
  p_order_id bigint, p_admin_phone text, p_amount_rials bigint,
  p_reason text, p_reference text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders; v_existing public.order_refunds;
  v_basis bigint; v_tokens bigint; v_removed bigint; v_refund public.order_refunds;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.order_refunds where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'replayed', true,
        'refund', to_jsonb(v_existing), 'tokensRemoved', v_existing.tokens_removed);
    end if;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'order_not_found'); end if;
  perform 1 from public.users where id = v_order.user_id for update;

  if v_order.status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'not_approved', 'status', v_order.status);
  end if;
  if p_amount_rials is null or p_amount_rials <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  v_basis := coalesce(v_order.received_amount_rials, v_order.price_rials);
  if v_order.refunded_amount_rials + p_amount_rials > v_basis then
    return jsonb_build_object('ok', false, 'error', 'exceeds_received',
      'alreadyRefunded', v_order.refunded_amount_rials, 'basis', v_basis);
  end if;

  -- Proportional token removal, capped twice (order remainder, then balance).
  if v_order.price_rials > 0 then
    v_tokens := floor(v_order.tokens::numeric * p_amount_rials / v_order.price_rials)::bigint;
  else
    v_tokens := 0;
  end if;
  v_tokens := least(v_tokens, v_order.tokens - v_order.refunded_tokens);
  v_removed := least(v_tokens, public._balance(v_order.user_id));
  if v_removed > 0 then
    perform public._consume_lots(v_order.user_id, v_removed);
    perform public._post_ledger(v_order.user_id, 'refund', -v_removed, null,
      'order', v_order.id::text, 'admin:' || p_admin_phone,
      'refund:' || coalesce(p_idempotency_key, v_order.id::text), null, p_reason,
      jsonb_build_object('refundAmountRials', p_amount_rials, 'reference', p_reference));
  end if;

  insert into public.order_refunds (order_id, user_id, amount_rials, tokens_removed,
    reason, reference, actor, idempotency_key)
  values (p_order_id, v_order.user_id, p_amount_rials, v_removed,
    p_reason, p_reference, p_admin_phone,
    coalesce(p_idempotency_key, 'refund-' || p_order_id::text || '-' || extract(epoch from now())::text))
  returning * into v_refund;

  update public.orders
    set refunded_amount_rials = refunded_amount_rials + p_amount_rials,
        refunded_tokens = refunded_tokens + v_removed,
        status = case when refunded_amount_rials + p_amount_rials >= v_basis and v_basis > 0
                      then 'refunded' else status end
    where id = p_order_id returning * into v_order;

  insert into public.admin_audit (actor, action, target, meta)
  values (p_admin_phone, 'order_refunded', 'order:' || p_order_id::text,
          jsonb_build_object('userId', v_order.user_id, 'amountRials', p_amount_rials,
                             'tokensRemoved', v_removed, 'reason', p_reason,
                             'reference', p_reference));

  return jsonb_build_object('ok', true, 'replayed', false,
    'refund', to_jsonb(v_refund), 'tokensRemoved', v_removed,
    'order', to_jsonb(v_order));
end;
$$;

revoke execute on function public.refund_order(bigint, text, bigint, text, text, text) from public;
grant execute on function public.refund_order(bigint, text, bigint, text, text, text) to service_role;
