-- Ronin Code — Phase 2: per-user provider keys (migration 7)
--
-- Implements docs/phase2-reseller-design.md §2/§9:
--   * user_provider_keys — ONE delegated provider key per user; the plaintext
--     is stored ONLY as AES-256-GCM ciphertext (`v1:` envelope, §2.3) plus a
--     SHA-256 fingerprint (lookup/auth + primary-key guard; never reversible).
--   * key_issuance_intents — durable intent rows; EVERY provider mutation
--     flows through an intent executed by the background worker. Claim
--     approval never calls the provider inline (§3).
--   * key_usage_snapshots / key_usage_daily — accumulated provider usage
--     (provider logs cap at 30 rows, no pagination) for panels + drift (§8).
--   * ledger kind 'convert' + begin_provider_conversion RPC (§9): lazy,
--     exactly-once v1→v2 conversion; amount frozen in one transaction.
-- All new tables are service-role only (RLS on, no end-user policies),
-- exactly like risk_flags / handoff_codes.

-- ── Per-user delegated provider key ────────────────────────────────────────
create table if not exists public.user_provider_keys (
  id                     bigint generated always as identity primary key,
  user_id                uuid not null unique references public.users (id) on delete cascade,
  encrypted_key          text,               -- v1:<b64 iv>:<b64 tag>:<b64 ct> (§2.3); NULL until create confirms
  key_fingerprint        text unique,        -- SHA-256 hex of the plaintext
  key_last4              text,
  provider_key_name      text not null,      -- ronin-<uuid8>-<intentId>
  token_limit_issued     bigint not null default 0,
  tokens_used_observed   bigint not null default 0,
  balance_observed       bigint,
  balance_observed_at    timestamptz,
  status                 text not null default 'pending_create'
    check (status in ('pending_create','active','frozen','needs_attention','deleted')),
  allowed_models         jsonb,              -- '"all"' snapshot when omitted at create (§3.2)
  claude_provider        text,               -- reserved; always NULL in Phase 2
  converted_at           timestamptz,
  converted_tokens       bigint,
  -- Reconciliation cursors (§2.4/§8.3)
  logs_total_seen        bigint not null default 0,
  logs_newest_hash       text,
  logs_gap_rows          bigint not null default 0,
  under_breach_streak    integer not null default 0,
  last_used_at           timestamptz,
  last_reconciled_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_upk_status on public.user_provider_keys (status, last_reconciled_at);

-- ── Durable issuance intents ────────────────────────────────────────────────
create table if not exists public.key_issuance_intents (
  id                     bigint generated always as identity primary key,
  user_id                uuid not null references public.users (id) on delete cascade,
  user_provider_key_id   bigint references public.user_provider_keys (id) on delete set null,
  kind                   text not null
    check (kind in ('create','topup','reduce','freeze','unfreeze','delete','convert')),
  source                 text not null
    check (source in ('claim','admin_charge','refund','suspend','reactivate','close','conversion','reconcile_fix')),
  order_id               bigint references public.orders (id) on delete set null,
  refund_id              bigint references public.order_refunds (id) on delete set null,
  ledger_idempotency_key text,
  idempotency_key        text not null unique,
  amount_tokens          bigint,
  target_token_limit     bigint,
  state                  text not null default 'pending'
    check (state in ('pending','in_flight','issued','confirmed','needs_attention','failed','cancelled','superseded')),
  attempt_count          integer not null default 0,
  attempts               jsonb not null default '[]'::jsonb,
  balance_before         bigint,
  used_before            bigint,
  provider_http_status   integer,
  provider_error_code    text,
  actor                  text,               -- 'admin:<phone>' | 'system' | 'system:reconciler'; for delete: the confirmation marker (§4.4)
  next_attempt_at        timestamptz not null default now(),
  locked_at              timestamptz,
  locked_by              text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz
);
create index if not exists idx_kii_drain on public.key_issuance_intents (state, next_attempt_at)
  where state in ('pending','in_flight');
create index if not exists idx_kii_user on public.key_issuance_intents (user_id, id desc);
create unique index if not exists idx_kii_one_live_create
  on public.key_issuance_intents (user_id)
  where kind in ('create','convert') and state in ('pending','in_flight');

-- ── Accumulated usage (poll snapshots + Tehran-day rollups) ─────────────────
create table if not exists public.key_usage_snapshots (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  user_provider_key_id bigint not null references public.user_provider_keys (id) on delete cascade,
  logs_total_seen bigint not null,
  rows_summed     integer not null,
  tokens_summed   bigint not null,
  partial         boolean not null default false,
  balance_after   bigint,
  polled_at       timestamptz not null default now()
);
create index if not exists idx_kus_user_time on public.key_usage_snapshots (user_id, polled_at);

create table if not exists public.key_usage_daily (
  user_id     uuid not null references public.users (id) on delete cascade,
  day         date not null,               -- Asia/Tehran day
  model       text not null,
  requests    integer not null default 0,
  cost_tokens bigint not null default 0,
  partial     boolean not null default false,
  primary key (user_id, day, model)
);

-- ── RLS: service role only ──────────────────────────────────────────────────
alter table public.user_provider_keys   enable row level security;
alter table public.key_issuance_intents enable row level security;
alter table public.key_usage_snapshots  enable row level security;
alter table public.key_usage_daily      enable row level security;
revoke all on public.user_provider_keys, public.key_issuance_intents,
  public.key_usage_snapshots, public.key_usage_daily from anon, authenticated;
grant all on public.user_provider_keys, public.key_issuance_intents,
  public.key_usage_snapshots, public.key_usage_daily to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── Ledger: allow the 'convert' kind (§2.5) ─────────────────────────────────
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check
  check (kind in ('purchase', 'consume', 'hold', 'release', 'adjust', 'expire', 'refund', 'convert'));

-- ── RPC: begin lazy v1→v2 conversion (§9.1) ─────────────────────────────────
-- Under the user-row lock: idempotent; defers while holds are in flight;
-- otherwise freezes amount = spendable (unexpired lots − active holds),
-- posts the delta-0 'convert' ledger marker (unique idempotency key makes a
-- racing second call a no-op) and stamps converted_at on the key shell row.
create or replace function public.begin_provider_conversion(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key public.user_provider_keys;
  v_amount bigint;
  v_holds bigint;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;

  select * into v_key from public.user_provider_keys where user_id = p_user_id;
  if found and v_key.converted_at is not null then
    return jsonb_build_object('ok', true, 'status', 'already_converted',
      'amount', coalesce(v_key.converted_tokens, 0));
  end if;

  v_holds := public._active_hold_tokens(p_user_id);
  if v_holds > 0 then
    return jsonb_build_object('ok', true, 'status', 'deferred_holds_active', 'amount', 0);
  end if;

  v_amount := greatest(0, public._unexpired_lot_tokens(p_user_id));

  if not found then
    insert into public.user_provider_keys (user_id, provider_key_name, status)
    values (p_user_id, 'ronin-' || substr(p_user_id::text, 1, 8) || '-pending', 'pending_create')
    returning * into v_key;
  end if;

  insert into public.ledger (user_id, kind, delta_tokens, amount_tokens, balance_after,
    ref_type, ref_id, actor, idempotency_key, meta)
  values (p_user_id, 'convert', 0, v_amount, public._balance(p_user_id),
    'provider_key', v_key.id::text, 'system', 'convert:v1:' || p_user_id::text,
    jsonb_build_object('phase', 2))
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  update public.user_provider_keys
    set converted_at = now(), converted_tokens = v_amount, updated_at = now()
    where id = v_key.id;

  return jsonb_build_object('ok', true, 'status', 'converted', 'amount', v_amount);
end;
$$;

revoke execute on function public.begin_provider_conversion(uuid) from public;
grant execute on function public.begin_provider_conversion(uuid) to service_role;
