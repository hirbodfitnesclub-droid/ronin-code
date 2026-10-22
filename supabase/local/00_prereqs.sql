-- LOCAL DEVELOPMENT ONLY — never run this on Supabase Cloud.
--
-- A real Supabase project already provides: the `auth` schema, the roles
-- anon / authenticated / service_role, and a search_path that lets GoTrue
-- resolve its tables. A vanilla local Postgres has none of that, so the dev
-- stack creates the minimum here, BEFORE GoTrue's own migrations run:
--   1. the auth schema (GoTrue's migrator assumes it exists),
--   2. the three API roles (service_role gets a dev-only password so the
--      local Node server can connect as it, mirroring production),
--   3. search_path = auth, public on this database (GoTrue queries its
--      tables unqualified).

create schema if not exists auth;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role login bypassrls password 'ronin-local-service';
  else
    alter role service_role with login bypassrls password 'ronin-local-service';
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

do $$
begin
  execute format('alter database %I set search_path to auth, public', current_database());
end $$;
