-- Ronin Code — first-login onboarding (migration 5)
--
-- Owner decision (2026-10-22): after a user's FIRST successful OTP login,
-- the panel shows ONE short onboarding screen — name (required), how they
-- heard about us (required, single-select), and optionally what they plan
-- to build. Answers live on the profile; `onboarded` flips true on submit
-- and gates the panel's post-login routing. The admin dossier shows the
-- name + acquisition source (+ goal when set). Submitting again simply
-- overwrites (harmless by design).

alter table public.users
  add column if not exists acquisition_source text,
  add column if not exists onboarding_goal text,
  add column if not exists onboarded boolean not null default false;
