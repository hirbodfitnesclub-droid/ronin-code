-- Ronin Code — subscription schema on Supabase Postgres (migration 1: tables, RLS)
--
-- Design rules (unchanged from the audited SQLite design):
--   * Identity lives in Supabase Auth (auth.users). public.users is the profile.
--   * The credit ledger is APPEND-ONLY; balance is always SUM(delta_tokens).
--   * ALL money mutations happen inside SECURITY DEFINER RPC functions
--     (migration 2). RLS below gives end-user JWTs read-only access to their
--     own rows and NO write path at all.
--   * All timestamps are timestamptz; all expiry math uses the DB clock (now()).

create extension if not exists pgcrypto;

-- ── Profiles ────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id            uuid primary key references auth.users (id) on delete cascade,
  phone         text not null unique,            -- local format 09xxxxxxxxx
  name          text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- A profile row appears automatically when Supabase Auth creates the user
-- (phone in auth.users is stored without '+', e.g. 98912…; normalize to 09…).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, phone)
  values (
    new.id,
    case
      when new.phone like '98%' and length(new.phone) = 12 then '0' || substr(new.phone, 3)
      else coalesce(nullif(new.phone, ''), 'unknown-' || new.id::text)
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ── Devices & refresh-token registry ────────────────────────────────────────
-- One row per signed-in device (a login). The device registry is AUTHORITATIVE
-- for the daily revalidation: a revoked device fails its next account-status
-- check even if its JWT has not expired yet.
create table if not exists public.devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  auth_session_id uuid,                          -- Supabase Auth (GoTrue) session
  name            text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  revoked_at      timestamptz
);
create index if not exists idx_devices_user on public.devices (user_id, created_at);
create index if not exists idx_devices_session on public.devices (auth_session_id);

-- Every refresh token the API hands out is registered by SHA-256 hash so that
-- rotation + REUSE DETECTION are enforced at our API boundary (GoTrue alone
-- tolerates a rotated token inside its grace window — our invariant cannot).
create table if not exists public.device_refresh_tokens (
  id         bigint generated always as identity primary key,
  device_id  uuid not null references public.devices (id) on delete cascade,
  token_hash text not null unique,
  state      text not null default 'current' check (state in ('current', 'rotated', 'revoked')),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
create index if not exists idx_drt_device on public.device_refresh_tokens (device_id, state);

-- ── OTP guard (user login) ──────────────────────────────────────────────────
-- GoTrue generates/verifies the OTP itself and tolerates unlimited tries; our
-- endpoint counts consecutive failures per phone and locks at 5 (product rule).
create table if not exists public.otp_guards (
  phone      text primary key,
  fail_count integer not null default 0,
  issued_at  timestamptz,
  locked     boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ── OTP codes — ADMIN login domain only ─────────────────────────────────────
-- The standalone admin app keeps its own OTP + session domain (separate from
-- Supabase Auth user sessions by design). Codes are HMAC-hashed at rest.
create table if not exists public.otp_codes (
  id         bigint generated always as identity primary key,
  phone      text not null,
  purpose    text not null default 'admin_login',
  code_hash  text not null,
  attempts   integer not null default 0,
  consumed   boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_otp_phone on public.otp_codes (phone, purpose, consumed, created_at);

-- ── Admin sessions (separate domain: own cookie, own CSRF) ─────────────────
create table if not exists public.admin_sessions (
  token_hash text primary key,
  phone      text not null,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ── Settings (JSON documents, admin-editable) ───────────────────────────────
create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

-- ── Card-to-card purchase claims ────────────────────────────────────────────
create table if not exists public.orders (
  id                    bigint generated always as identity primary key,
  user_id               uuid not null references public.users (id) on delete cascade,
  pack_id               text not null,
  pack_title            text not null,
  tokens                bigint not null,        -- snapshot at claim time
  price_rials           bigint not null,          -- snapshot at claim time
  received_amount_rials bigint,                   -- amount admin actually received
  payer_name            text not null,
  card_last4            text not null,
  reference             text not null,            -- tracking code (شماره پیگیری)
  paid_at_text          text,
  status                text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason         text,
  admin_note            text,
  reviewed_by           text,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists idx_orders_status on public.orders (status, created_at);
create index if not exists idx_orders_user on public.orders (user_id, created_at);

-- ── Append-only credit ledger ───────────────────────────────────────────────
create table if not exists public.ledger (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  kind            text not null check (kind in ('purchase', 'consume', 'hold', 'release', 'adjust', 'expire')),
  delta_tokens    bigint not null default 0,
  amount_tokens   bigint,                          -- for hold/release rows: the reserved amount
  balance_after   bigint,
  ref_type        text,                            -- order|hold|admin|system|lot
  ref_id          text,
  actor           text,                            -- user:<id> | admin:<phone> | system
  idempotency_key text,
  request_id      text,
  note            text,
  meta            jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists idx_ledger_idem on public.ledger (idempotency_key) where idempotency_key is not null;
create index if not exists idx_ledger_user on public.ledger (user_id, created_at);

-- ── Credit lots (per-grant expiry, FIFO consumption) ────────────────────────
create table if not exists public.credit_lots (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.users (id) on delete cascade,
  source       text not null,                      -- order:<id> | admin | system
  tokens_total bigint not null,
  tokens_left  bigint not null,
  expires_at   timestamptz,                        -- NULL = never expires
  warned_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_lots_user on public.credit_lots (user_id, expires_at);

-- ── Metering holds (reserve → commit=consume / release) ─────────────────────
create table if not exists public.holds (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  request_id      text not null,
  idempotency_key text,
  model           text not null,
  multiplier      numeric not null,
  reserved_tokens bigint not null,
  actual_tokens   bigint,
  status          text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  response_json   jsonb,                           -- stored upstream response for idempotent replay
  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);
create unique index if not exists idx_holds_idem on public.holds (user_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_holds_user_status on public.holds (user_id, status);

-- ── Admin audit log ─────────────────────────────────────────────────────────
create table if not exists public.admin_audit (
  id         bigint generated always as identity primary key,
  actor      text not null,                        -- admin phone
  action     text not null,
  target     text,
  meta       jsonb,
  created_at timestamptz not null default now()
);

-- ── Sliding-window rate-limit events ────────────────────────────────────────
create table if not exists public.rate_events (
  key        text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_key on public.rate_events (key, created_at);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- End-user JWTs (authenticated role): read ONLY their own rows, write NOTHING
-- directly — every mutation goes through the SECURITY DEFINER RPCs or the
-- service role. Service-side tables get RLS with no user policies at all.
alter table public.users                 enable row level security;
alter table public.devices               enable row level security;
alter table public.device_refresh_tokens enable row level security;
alter table public.otp_guards            enable row level security;
alter table public.otp_codes             enable row level security;
alter table public.admin_sessions        enable row level security;
alter table public.settings              enable row level security;
alter table public.orders                enable row level security;
alter table public.ledger                enable row level security;
alter table public.credit_lots           enable row level security;
alter table public.holds                 enable row level security;
alter table public.admin_audit           enable row level security;
alter table public.rate_events           enable row level security;

drop policy if exists users_read_own on public.users;
create policy users_read_own on public.users
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists devices_read_own on public.devices;
create policy devices_read_own on public.devices
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists orders_read_own on public.orders;
create policy orders_read_own on public.orders
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists ledger_read_own on public.ledger;
create policy ledger_read_own on public.ledger
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists lots_read_own on public.credit_lots;
create policy lots_read_own on public.credit_lots
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists holds_read_own on public.holds;
create policy holds_read_own on public.holds
  for select to authenticated using (user_id = (select auth.uid()));

-- Shop display data is readable when signed in; token_config stays private.
drop policy if exists settings_read_display on public.settings;
create policy settings_read_display on public.settings
  for select to authenticated using (key in ('card', 'packs', 'models'));

-- Table privileges: strip the broad defaults, then grant back exactly the
-- SELECTs the policies above govern. The service role (used by our servers)
-- retains full access and bypasses RLS.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.users, public.devices, public.orders, public.ledger,
  public.credit_lots, public.holds, public.settings to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
