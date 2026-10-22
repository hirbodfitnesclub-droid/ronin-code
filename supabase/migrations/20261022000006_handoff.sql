-- Ronin Code — desktop-app handoff return codes (migration 6)
--
-- Owner flow (Cursor-style browser login): the user signs in inside the web
-- panel, asks for a return code, and types it into the desktop app. The app
-- exchanges the code ONCE for a full app session.
--
-- Why our own codes + sessions: GoTrue's generate_link is email-only
-- (verified empirically against the pinned GoTrue v2.197 binary), so it
-- cannot mint a session for a phone identity from a short code. The code
-- below is therefore a Ronin artifact: single-use, 10-minute TTL, stored
-- only as a SHA-256 hash of the normalized code (uppercase, dashes/spaces
-- stripped). The exchange mints OUR OWN app session (see server auth.js):
-- the device row is tagged kind='handoff' so refresh rotation happens
-- locally instead of through GoTrue; kind='gotrue' (the default) marks the
-- ordinary OTP-login devices.

create table if not exists public.handoff_codes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_handoff_codes_hash on public.handoff_codes (code_hash);
create index if not exists idx_handoff_codes_user on public.handoff_codes (user_id, created_at);

alter table public.handoff_codes enable row level security;
revoke all on public.handoff_codes from anon, authenticated;
grant all on public.handoff_codes to service_role;
grant usage, select on all sequences in schema public to service_role;

alter table public.devices
  add column if not exists kind text not null default 'gotrue';
