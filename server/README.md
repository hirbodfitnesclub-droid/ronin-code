# Ronin Code — Subscription Server

Accounts, token credit, card-to-card sales and the metering proxy for Ronin
Code's own subscription. The BYOK desktop flow stays fully local and never
touches this server's data; the subscription flow is online-only by design
(no server = no trustworthy metering).

Since the Supabase migration, **Supabase is the data + identity layer**:
Postgres holds every money table, Supabase Auth (GoTrue) owns end-user
identity and sessions. The two Node apps stay exactly what they were — the
metering proxy (it holds the upstream key and streams) and the standalone
admin app — now reading/writing Postgres instead of SQLite.

```
desktop app ──(user session token)──▶ user API :7443 ──▶ metering proxy ──▶ upstream gateway
                                          │        │
admin browser ──(admin session)────▶ admin app :7444 (standalone)
                                          │        │
                                  Postgres (Supabase): users · append-only ledger · lots ·
                                                       holds · orders · audit · devices
                                  Supabase Auth: identities, OTP, token sessions
                                  Send SMS hook: user API /hooks/send-sms ──▶ Kavenegar
```

## Architecture — where each piece lives

| Concern | Lives in | Notes |
|---|---|---|
| Users, ledger, lots, holds, claims, audit, settings, devices | Postgres schema `public` (`../supabase/migrations/`) | RLS on; users can SELECT only their own rows |
| **All money mutations** | `SECURITY DEFINER` RPCs in `20261022000002_rpc.sql` | `grant_credit`, `reserve_hold`, `commit_hold`, `release_hold`, `adjust_credit`, `create_claim`, `approve_claim`, `reject_claim`, `run_expiry_sweep`, `account_status`. Direct table writes are revoked from `anon`/`authenticated`; only `service_role` may execute the RPCs |
| End-user identity + sessions | Supabase Auth (GoTrue), phone OTP | SMS delivered via our Send SMS hook → Kavenegar Verify Lookup |
| OTP brute-force lockout (5 attempts) | `public.otp_guards` (ours) | GoTrue does **not** lock a code after N wrong tries — verified against v2.197; our verify wrapper counts failures and locks |
| Refresh-token reuse detection | `public.device_refresh_tokens` (ours) | GoTrue rotates but does **not** detect reuse of rotated-away tokens — verified; we keep a SHA-256 registry of issued refresh tokens per device and enforce rotation/reuse ourselves |
| Device registry + cap (max 2) | `public.devices`, bound to the Auth `session_id` | **Authoritative for access** — every authenticated request checks it; revoking a device kills its next request and its daily check |
| Metering proxy, admin app | This Node service (unchanged APIs) | Proxy stays standalone on purpose: Edge Functions cap at 150s idle / 400s wall — too tight for multi-minute agent streams whose usage is only known at stream end |

## Daily account revalidation (anti-circumvention)

The desktop app re-validates the account on **every launch and at least once
per day** via one lightweight call: `GET /api/account-status` (Bearer). The
response is pure server truth — `{ status, isActive, balanceTokens,
spendableTokens, lots[{tokensLeft, expiresAt}], deviceAuthorized,
activeDevices, serverTime }` — computed by the `account_status` RPC:

- **Balance/usage truth lives only server-side.** The app never holds a
  mutable local copy; the ledger is the only balance.
- **All expiry math uses the server clock** (the RPC returns `serverTime`;
  lot expiries are evaluated in Postgres).
- **The device registry is authoritative.** Revoking a device (admin action,
  remote logout, device-cap eviction, refresh-reuse response) makes its next
  check fail with 401; account suspension takes effect at the next check at
  the latest (and immediately for live sessions — toggling a user off also
  kills their Auth sessions).

## Local development (no Docker on this machine)

Docker and the Supabase CLI are **not available in this environment**, so the
local stack runs the *genuine* components directly — no emulation:

- **PostgreSQL 18.4**, real binaries via the `@embedded-postgres/linux-x64`
  npm package (devDependency), data dir + binaries staged under the temp dir.
- **Supabase Auth v2.197.0**, the official `supabase/auth` release binary
  (`auth serve` + `auth migrate`). One-time download:
  `curl -L https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-amd64.tar.xz | tar -xJ -C server/tools/` (git-ignored).
- `../supabase/local/00_prereqs.sql` creates the local-only scaffolding a real
  Supabase project already has (auth schema, `anon`/`authenticated`/
  `service_role` roles). **Never run it on Supabase Cloud** — there you apply
  only `../supabase/migrations/*.sql`, in order, via the Supabase CLI or
  dashboard SQL editor, after enabling Phone auth + the Send SMS hook in the
  dashboard (hook URL = `https://<api-host>/hooks/send-sms`, same secret).

```bash
cd server
npm install
npm run dev     # PG :55432 (db ronin_dev) + Auth :9999 + API :7443 + admin :7444, console SMS
npm test        # full suite — spins the same real stack per test file, ephemeral ports
```

Production shape: `cp .env.example .env`, `npm start` (API + admin) /
`npm run admin` (panel only), pointed at the Supabase Cloud project via
`DATABASE_URL` + `SUPABASE_AUTH_URL`.

## Design — Liro flows, Ronin internals

User/admin-visible flows deliberately mirror the Liro project (studied in
`~/workspace/research_notes/liro-study/report.md`); the internals follow the
approved security review (`ronin-subscription-security.md`):

**Copied from Liro**
- Card-to-card claims: `{payerName, cardLast4, reference (tracking code), paidAtText?}` —
  **no receipt screenshot** (Liro doesn't have one either). Max **3 pending** claims per user.
- Shop card + packs are runtime settings (JSONB in the `settings` table), admin-editable.
- Admin approval is **one atomic, idempotent transaction** (the `approve_claim`
  RPC); a second review returns **409** and can never double-credit. Approval
  writes an append-only ledger row; rejection stores a user-visible reason.
- SMS via **Kavenegar Verify Lookup** (`KAVENEGAR_API_KEY` + template names in
  env): 6 digits, 5-minute expiry, 5 attempts, strict send rate limits.
- `admin_audit` row for every sensitive admin action.

**Ronin upgrades / deliberate deviations**
- **Auth:** OTP login for everyone via Supabase Auth — 15-minute access token +
  30-day refresh with rotation. Reuse detection, the device registry and the
  2-device cap are enforced by this service on top of Auth (see table above).
  Send rate limits (60s cooldown, 5/day/phone, 20/day/IP) are recorded only
  after the Auth server accepts the send, so its rejections can't burn a
  user's budget.
- **Admin is a fully standalone app** (owner decision): separate listener
  (`ADMIN_PORT`), its own OTP login restricted to `ADMIN_PHONES` (own
  `otp_codes` table, HMAC-hashed via `AUTH_SECRET` — deliberately NOT Supabase
  Auth, its own session domain), sessions in `admin_sessions`, cookie
  `ronin_admin` (HttpOnly, SameSite=Strict) + per-session CSRF token. User
  tokens are never consulted by the admin app and vice versa.
- **Credit is an append-only ledger** (`purchase|consume|hold|release|adjust|expire`).
  Balance is always `SUM(delta_tokens)` — never edited. Credit lots track
  per-grant expiry (FIFO consumption); a 6-hourly sweep warns ~72h before
  expiry and debits expired leftovers through `expire` entries, keeping
  `balance == Σ lots.tokens_left`.
- **Metering proxy** `POST /v1/chat/completions`: reserve (hold) the estimated
  max cost via `reserve_hold` RPC (per-user row lock — concurrent reserves
  serialize and can never overdraw) → forward with the server-side upstream key
  (never logged, never returned) → settle from the upstream response's own
  `usage` (client numbers are never trusted) → release the remainder.
  `Idempotency-Key` replays the stored response instead of double-charging.
  Per-account rate and concurrency limits. Commits are capped so a balance
  can never go negative. Admin approval takes the **actually-received
  amount**: if it differs from the pack price, credit is granted
  proportionally (partial credit).
- Admin manual charge/debit requires a **written note** and is audited.

## SMS templates

Four product notifications, all template/pattern names from env (Kavenegar panel):
`KAVENEGAR_TEMPLATE` (OTP), `KAVENEGAR_TEMPLATE_PACKAGE_ACTIVATED`,
`KAVENEGAR_TEMPLATE_EXPIRY_WARNING`, `KAVENEGAR_TEMPLATE_EXPIRED`, plus optional
`KAVENEGAR_TEMPLATE_ORDER_REJECTED`. `SMS_PROVIDER=console` logs codes instead of
sending (dev/tests; codes are also kept in an in-memory outbox for tests).

## API surface (user)

| Route | Notes |
|---|---|
| `POST /api/auth/otp/request` · `POST /api/auth/otp/verify` | OTP login (via Supabase Auth); verify returns `{accessToken, refreshToken, user, deviceId}` |
| `POST /api/auth/refresh` | Rotates; reuse → device + session family revoked |
| `POST /api/auth/logout` · `POST /api/auth/logout-all` | Bearer |
| `GET /api/devices` · `DELETE /api/devices/:id` | Device registry / remote logout |
| `GET /api/me` | Profile + balance + spendable |
| `GET /api/account-status` | **Daily revalidation** — server-truth status (see above) |
| `GET /api/packs` | Packs (tokens computed) + shop card |
| `GET /api/models` | Model multiplier table (display) |
| `POST /api/orders` · `GET /api/orders` | Card-to-card claims |
| `GET /api/credits` | Balance + ledger history + orders (Liro parity) |
| `POST /v1/chat/completions` | Metered, OpenAI-compatible; `Idempotency-Key` supported |
| `POST /hooks/send-sms` | Supabase Auth Send SMS hook (Standard Webhooks signed) |
| `GET /healthz` | Liveness |

Admin API lives under `/admin-api/*` **on the admin listener only** (overview,
users + charge/toggle, orders queue + review, settings: card/packs/models/
token-config, audit).

## Admin panel (React console, PRD §6)

The standalone admin app serves the React console built from
`web/admin-panel/` (Vite build output in `web/admin-panel/dist`, Persian RTL,
same design tokens as the product). It replaces the old vanilla UI.

- **Access (Liro capability model):** OWNER = phone in `ADMIN_PHONES` (all
  capabilities; claim approval, staff editing and the audit viewer are
  owner-only). FINANCE STAFF live in the `finance_staff` settings document
  (`[{phone, caps[]}]`) and log in with the same OTP; every route enforces its
  capability server-side: `finance_view`, `finance_user`, `risk_manage`,
  `expense_write`, `refund_write`, `policy_write`, `export`. (Liro's
  referral/KYC/payout caps do not exist — there is no referral system,
  PRD §9.1.) Every sensitive action writes an `admin_audit` row.
- **Review queue + receipts:** claims carry `receipt_path` + `receipt_sha256`
  (migration `20261022000003_admin_panel.sql`, additive — see the merge flag
  below). `GET /admin-api/orders/:id/receipt` serves the image from the local
  `RECEIPTS_DIR` (dev) or via a short-lived signed URL into the private
  Supabase Storage bucket (Cloud, service-role key stays server-side). The
  queue flags claims whose image hash also appears on another claim
  (passive duplicate warning — the human still decides).
- **Refunds:** `POST /admin-api/orders/:id/refund` → `refund_order` RPC:
  atomic, idempotent on the client-supplied key, proportional token removal
  capped at the order remainder and at the user's balance; a full refund
  flips the order to `refunded`.
- **Finance console:** P&L over orders/refunds/expenses, expenses CRUD,
  named periods, CSV export — deliberately **no** bank-statement
  import/reconciliation (owner decision, PRD §9.2).
- **Analytics + AI analyst:** dashboards from the books (growth, revenue,
  consumption, top models, claim outcomes) and an on-demand analyst chat
  (`POST /admin-api/analyst/chat`) that ships aggregate context to the cheap
  OpenAI-compatible gateway (`ANALYST_*`, falling back to `UPSTREAM_*`).
  On-demand only — no cron, no daily reports (PRD §9.3).
- **User dossier extras:** devices list + revoke, risk flags lifecycle —
  driven by the same `devices` registry that powers daily revalidation.

## Honest gaps

- **Streaming** completions are proxied live and settled from the final usage
  chunk (or a text-length estimate if the upstream sends none), but streamed
  responses are **not idempotency-replayable** (nothing is stored to replay).
- If an upstream response carries **no `usage` at all** (buffered mode), cost
  falls back to a characters/4 estimate of the reply — documented behaviour,
  not silent.
- `authenticate()` verifies the JWT locally when `SUPABASE_JWT_SECRET` is set
  (HS256), else falls back to a GoTrue `GET /user` round-trip; either way it
  does one indexed device/user lookup per request — the price of the
  authoritative device registry.
- Killing a revoked device's GoTrue session is **best-effort SQL**
  (`DELETE FROM auth.sessions/refresh_tokens`, local-granted; on Supabase
  Cloud it depends on service-role access to the auth schema). The device
  registry check is the authoritative gate and never depends on it.
- GoTrue's own per-user SMS limiter (1 send per wall-clock second, not
  configurable below) can briefly reject back-to-back sends in tests; real
  users are governed by our 60s cooldown.
- Admin MFA beyond phone-OTP (TOTP) and PSP (online gateway) payments are
  future work — card-to-card is the launch rail, per the owner.
- **Merge flag (receipt claims):** the receipt-only claim rework was landing
  concurrently on `supabase-migration`; on this branch migration 3 adds the
  receipt columns additively and the admin side fully reads them, but claim
  *creation* (`create_claim` RPC + the user API) still takes the legacy form
  fields until the two branches merge — at merge time keep migration 3's
  columns/RPCs and take the rework's creation side.
