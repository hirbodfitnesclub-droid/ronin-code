# Ronin Code — Subscription Server (Phase E)

Accounts, token credit, card-to-card sales and the metering proxy for Ronin
Code's own subscription. The BYOK desktop flow stays fully local and never
touches this server; the subscription flow is online-only by design (no
server = no trustworthy metering).

```
desktop app ──(user session token)──▶ user API :7443 ──▶ metering proxy ──▶ upstream gateway
admin browser ──(admin session)────▶ admin app :7444 (standalone)
                                          │
                              SQLite: users · append-only ledger · lots · holds · orders · audit
```

## Run

```bash
cd server
cp .env.example .env   # fill in real values — keys are set together with the owner at launch
npm install            # no runtime dependencies; this only validates the toolchain
npm start              # user API on PORT (7443) + admin app on ADMIN_PORT (7444)
npm run admin          # run ONLY the standalone admin app
npm test               # full test suite (node:test, fake upstream, console SMS)
```

Requires Node ≥ 22.5 (storage is `node:sqlite` — zero npm dependencies).
Data lives in `DB_PATH` (default `server/data/ronin.db`, git-ignored).

## Design — Liro flows, Ronin internals

User/admin-visible flows deliberately mirror the Liro project (studied in
`~/workspace/research_notes/liro-study/report.md`); the internals follow the
approved security review (`ronin-subscription-security.md`):

**Copied from Liro**
- Card-to-card claims: `{payerName, cardLast4, reference (tracking code), paidAtText?}` —
  **no receipt screenshot** (Liro doesn't have one either). Max **3 pending** claims per user.
- Shop card + packs are runtime settings (JSON in the `settings` table), admin-editable.
- Admin approval is **one atomic, idempotent transaction**; a second review returns **409**
  and can never double-credit. Approval writes an append-only ledger row; rejection stores a
  user-visible reason + admin note.
- SMS via **Kavenegar Verify Lookup** (`KAVENEGAR_API_KEY` + template names in env), OTP rules:
  6 digits, HMAC-hashed at rest, 5-minute expiry, 5 attempts, strict send rate limits.
- `admin_audit` row for every sensitive admin action.

**Ronin upgrades / deliberate deviations**
- **Auth deviation (user-approved):** Liro uses OTP-for-signup + password login. Ronin uses
  **OTP login for everyone** — 15-minute access token + 30-day **rotating refresh token with
  reuse detection** (presenting a rotated-away refresh token revokes the whole family).
  Device registry, max `MAX_DEVICES` (2) concurrent devices, remote logout per device / all.
- **Admin is a fully standalone app** (owner decision, supersedes Liro's in-app placement):
  separate HTTP listener (`ADMIN_PORT`), its own OTP login restricted to `ADMIN_PHONES`,
  sessions in a separate `admin_sessions` table with its own cookie (`ronin_admin`,
  HttpOnly, SameSite=Strict) and per-session CSRF token. User tokens are never consulted
  by the admin app, and admin sessions grant nothing on the user API. In `npm start` both
  listeners live in one process for convenience, but they are separate `http.Server`
  instances with separate routers/session domains; `npm run admin` runs the panel alone.
- **Credit is an append-only ledger** (`purchase|consume|hold|release|adjust|expire`).
  Balance is always `SUM(delta_tokens)` — never edited. Credit lots track per-grant expiry
  (FIFO consumption); a 6-hourly sweep warns ~72h before expiry and debits expired
  leftovers through `expire` entries, keeping `balance == Σ lots.tokens_left`.
- **Metering proxy** `POST /v1/chat/completions`: reserve (hold) the estimated max cost
  **inside a BEGIN IMMEDIATE transaction** → forward with the server-side upstream key
  (never logged, never returned) → settle from the upstream response's own `usage`
  (client numbers are never trusted) → release the remainder. `Idempotency-Key`
  replays the stored response instead of double-charging. Per-account rate and
  concurrency limits. Commits are capped so a balance can never go negative.
  Admin approval takes the **actually-received amount**: if it differs from the pack
  price, credit is granted proportionally (partial credit).
- Admin manual charge/debit requires a **written note** (four-eyes culture) and is audited.

## SMS templates

Four product notifications, all template/pattern names from env (Kavenegar panel):
`KAVENEGAR_TEMPLATE` (OTP), `KAVENEGAR_TEMPLATE_PACKAGE_ACTIVATED`,
`KAVENEGAR_TEMPLATE_EXPIRY_WARNING`, `KAVENEGAR_TEMPLATE_EXPIRED`, plus optional
`KAVENEGAR_TEMPLATE_ORDER_REJECTED`. `SMS_PROVIDER=console` logs codes instead of
sending (dev/tests; codes are also kept in an in-memory outbox for tests).

## API surface (user)

| Route | Notes |
|---|---|
| `POST /api/auth/otp/request` · `POST /api/auth/otp/verify` | OTP login; verify returns `{accessToken, refreshToken, user, deviceId}` |
| `POST /api/auth/refresh` | Rotates; reuse → family revoked |
| `POST /api/auth/logout` · `POST /api/auth/logout-all` | Bearer |
| `GET /api/devices` · `DELETE /api/devices/:id` | Device registry / remote logout |
| `GET /api/me` | Profile + balance + spendable |
| `GET /api/packs` | Packs (tokens computed) + shop card |
| `GET /api/models` | Model multiplier table (display) |
| `POST /api/orders` · `GET /api/orders` | Card-to-card claims |
| `GET /api/credits` | Balance + ledger history + orders (Liro parity) |
| `POST /v1/chat/completions` | Metered, OpenAI-compatible; `Idempotency-Key` supported |
| `GET /healthz` | Liveness |

Admin API lives under `/admin-api/*` **on the admin listener only** (overview,
users + charge/toggle, orders queue + review, settings: card/packs/models/
token-config, audit).

## Honest gaps

- **Streaming** completions are proxied live and settled from the final usage
  chunk (or a text-length estimate if the upstream sends none), but streamed
  responses are **not idempotency-replayable** (nothing is stored to replay).
- If an upstream response carries **no `usage` at all** (buffered mode), cost
  falls back to a characters/4 estimate of the reply — documented behaviour,
  not silent.
- Single-process SQLite: correct and race-safe for one node, but horizontal
  scaling would need the Postgres move Liro already demonstrates.
- Admin MFA beyond phone-OTP (TOTP) and PSP (online gateway) payments are
  future work — card-to-card is the launch rail, per the owner.
```
