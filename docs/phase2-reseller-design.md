# Ronin Code — Phase 2: Per-User Provider Keys (Reseller) — Design

Status: **DESIGN ONLY** — no implementation code in this document's branch.
Author: Phase-2 architect pass, 2026-10-23.
Authoritative inputs, in precedence order:

1. CheapVibeCode reseller API contract (`~/workspace/user/files/reseller-api-agent__1__0_afjn.md`) — wins on any conflict.
2. Binding product constraints in `MEMORY.md` (ledger stays the purchase record; packs 20M / 50M / 100M / 400M tokens; the internal $/Toman rate is **never** displayed anywhere; login mandatory; max 2 devices; daily revalidation unchanged; provider is the usage source of truth in Phase 2).
3. OpenRouter Management Keys research (`~/workspace/research_notes/openrouter-management-keys-20261023-0553/report.md`) — patterns only. Where it conflicts with the provider contract, the contract wins (notably: the OpenRouter cumulative-ceiling top-up trap does **not** apply here; CheapVibeCode `additional_tokens` is genuinely additive).

> **Numbering correction (read first).** The assignment brief assumed the migration chain ends at logical `00005`. It does not: the repo already contains `20261022000006_handoff.sql` (desktop handoff return codes). The Phase-2 migration is therefore the logical **00007**, file `20261023000007_provider_keys.sql`, following the existing timestamp-prefix convention. Everything below that says "migration 00007" means that file.

---

## 0. End state in one page

- Every subscription user owns exactly **one delegated CheapVibeCode key**, created by the primary (control-plane) key the first time a purchase is approved for them, topped up additively on later purchases, frozen on suspension, deleted on account closure.
- The Supabase **ledger remains the purchase record** — what the user paid for, in tokens, with the existing atomic `approve_claim` RPC untouched. The provider key allowance is the *spendable* representation of that record in Phase 2.
- `server/src/proxy.js` becomes a **thin forwarder**: no Hold/Commit, no multipliers, no shared upstream key for subscription users. The provider enforces the cap; a provider `402` surfaces as the existing `insufficient_credit` error and the existing GUI credit banner.
- BYOK is **completely unchanged** (see §1.3 for how the two routes are distinguished today and how that distinction is preserved).
- All provider mutations flow through **durable intent rows** (`key_issuance_intents`) executed by a background worker. Claim approval never calls the provider inline and never fails because the provider is down.
- Money correctness outranks speed everywhere the contract is ambiguous. Every ambiguity found is listed in §13 with the safer interpretation chosen.

Non-goals / out of scope:

- Per-key Claude provider override (`claude_provider`: `kiro` / `claude_max` / `cc_max`). The contract supports it and the schema reserves a nullable column (§2.1), but no Phase-2 flow reads or writes it.
- Key transfer (`POST /v1/keys/transfer`). Not used. Donor-deletion semantics make it a poor fit for account closure (we delete, we do not transfer).
- Provider usage WebSocket (`/v1/usage/ws`) as a data source. Noted as a future freshness upgrade in §8.4; the polling design does not depend on it.
- Runtime surfaces other than `POST /v1/chat/completions`. The embedded engine speaks OpenAI-completions only (host `engine.js`), so the relay keeps exactly that one route.

---

## 1. Current state (verified in the repo)

### 1.1 Money and metering today

- `supabase/migrations/20261022000001_schema.sql` … `20261022000006_handoff.sql`: append-only `ledger`, `credit_lots` (FIFO, per-lot expiry), `holds` (reserve → commit/release), `orders` (receipt-photo claims), `risk_flags` (migration 00004), `admin_audit`, `devices` + `device_refresh_tokens`, `handoff_codes`.
- All money mutations happen inside SECURITY DEFINER RPCs (`20261022000002_rpc.sql`, amended by 00003/00004). JS is a thin wrapper (`server/src/ledger.js`, `server/src/orders.js`).
- `approve_claim` is one atomic, idempotent transaction: order → `approved`, `_grant` writes the ledger `purchase` entry + a credit lot, audit row. A second review returns `already_reviewed` → HTTP 409. **Phase 2 does not modify this RPC.**
- `server/src/orders.js#reviewOrder` is the only caller; the admin route is `POST /admin-api/orders/:id/review` (owner-only, `server/src/admin/app.js`).
- `server/src/proxy.js#handleChatCompletions`: authenticate (done by the route in `server/src/app.js`) → admin model-enabled check → multiplier lookup → `reserve_hold` RPC → forward to `cfg.upstreamBaseUrl` with `cfg.upstreamApiKey` (env `UPSTREAM_API_KEY`, the shared v1 key) → parse `usage` from the upstream response → `commit_hold` / `release_hold`. Idempotency-Key replay returns the stored response.
- Balance reads today: `GET /api/me`, `GET /api/credits`, `GET /api/account-status` (`public.account_status` RPC) — all computed from ledger/lots/holds.
- Refunds (`refund_order` RPC, migration 00004) and admin manual charges (`adjust_credit` RPC via `POST /admin-api/users/:id/charge`) move ledger tokens only. Phase 2 must mirror both to the provider (§4.5), or reconciliation will report phantom drift.
- User suspension today: `POST /admin-api/users/:id/toggle-active` (cap `risk_manage`) sets `users.is_active`, calls `auth.logoutAll` (revokes all devices/sessions), writes `admin_audit`. There is **no account-closure / user-deletion action anywhere** — see §13, item C2.

### 1.2 Risk / analyst plumbing today (reused, not reinvented)

- `public.risk_flags` (migration 00004): `user_id`, `kind` (free text, ≤40 chars enforced in the admin route), `note`, `status open|resolved`, `created_by`, `resolved_by/at`. Admin UI: user dossier → `UserRiskDevices.tsx`; API: `GET/POST /admin-api/users/:id/risk-flags`, `POST /admin-api/risk-flags/:id/resolve` (cap `risk_manage`).
- `admin_audit` via `audit()` in `server/src/db.js` for every sensitive admin action.
- AI analyst (`server/src/admin/analytics.js`): on-demand only, aggregates from users/orders/ledger/holds. Phase 2 adds provider figures to its context (§7.4) but keeps it on-demand.
- Admin overview (`GET /admin-api/overview`, cap `finance_view`) aggregates counts/sums in SQL.

### 1.3 How BYOK vs subscription is distinguished in the host today

This is the seam Phase 2 must preserve exactly:

- **BYOK**: providers `anthropic | openai | google | openrouter | custom` in `host/src/config.js#PROVIDERS`. Keys are user-supplied, stored as provider → key-list in `auth.json` (file mode 0600) under the Ronin data dir (`host/src/paths.js#AUTH_PATH`). Turns build an attempt chain with `host/src/router.js#buildAttempts` (multi-key LRU rotation + cooldowns + failover).
- **Subscription**: the synthetic provider `ronin-subscription` (`host/src/router.js#SUBSCRIPTION_PROVIDER`). It has **no stored key**: `resolveApiKey` returns the *session access token* from `AuthManager.ensureFreshAccess()`, and `baseUrl` is `${serverUrl}/v1` — i.e. the Ronin server proxy. A turn is a subscription turn iff the GUI sends a catalog `modelId` (`POST /api/turn` in `host/src/routes.js`, validated against `config.enabledModels`), which dispatches `runSubscriptionLive` in `host/src/engine.js`. The engine registers the provider with the Pi SDK as an OpenAI-compatible endpoint whose key travels via the process env var `RONIN_SUBSCRIPTION_KEY` and is sent as `Authorization: Bearer <session token>` to the proxy; the proxy's `requireUser` authenticates that token.
- Subscription gating: `AuthManager.subscriptionLocked()` (host `auth.js`) over the cached `/api/account-status` payload; `classifyProxyError` (host `router.js`) maps proxy failures to `insufficient_credit` (402 / `insufficient_credit` in the message), `unauthorized` (401), `model_disabled` (403). The GUI (`gui/src/features/chat/useChat.ts`) turns `insufficient_credit` into the `credit` banner — **that banner is the "existing credit-exhausted state" this design targets**, plus `subscription_locked` → `locked` banner.
- Session credentials live in `credentials.json` via `CredentialStore` (host `auth.js`, mode 0600 today; the class is explicitly shaped to be swapped for Windows Credential Manager behind the same load/save/clear interface). Refresh tokens never land in `config.json`, `localStorage`, or the GUI.

Consequence for Phase 2: the engine sends exactly **one** Bearer credential per subscription request, and today that credential *is* the session token. Delivering a delegated key to the host therefore changes the proxy's authentication model — §5 resolves this with a dual-auth proxy rather than pretending the seam doesn't exist.

### 1.4 Panels today

- User panel (`web/user-panel`): API layer `src/lib/api/{live,mock,session,types}.ts`; dashboard usage aggregates are **derived client-side from `/api/credits` ledger `consume` rows** (`src/lib/api/usage.ts#deriveUsage`). In per-user mode there are no `consume` rows — this breaks silently unless replaced (§7.3).
- Admin panel (`web/admin-panel`): API client `src/lib/api.ts`; user dossier `src/features/users/UserDetailScreen.tsx` shows profile, balance, ledger, orders, lots, open-risk-flag count, and (cap `risk_manage`) the devices/risk section. The provider-key section slots in beside lots (§7.2).
- Env names confirmed present in `server/.env` (names only, values never read for this document): `CVC_BASE_URL`, `CVC_PRIMARY_API_KEY`, plus the legacy `UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY`. `server/src/config.js` does **not** yet map the `CVC_*` names — Phase 2 adds them (§10).

---

## 2. Data model — migration 00007

File: `supabase/migrations/20261023000007_provider_keys.sql`. Style follows migrations 00001–00006: `create table if not exists`, RLS on, service-role-only for server-side tables, grants/revokes spelled out, header comment stating the owner decisions it implements.

### 2.1 `public.user_provider_keys` — one row per user

```sql
create table if not exists public.user_provider_keys (
  id                     bigint generated always as identity primary key,
  user_id                uuid not null unique references public.users (id) on delete cascade,
  -- Encrypted delegated key (see §2.3). NULL until the create intent succeeds.
  encrypted_key          text,
  -- SHA-256 hex of the plaintext key. Lookup/auth + primary-key guard only;
  -- a hash cannot be turned back into a spendable key.
  key_fingerprint        text unique,
  -- Display hint for admins: last 4 chars only, e.g. '…9f3k'. Never the prefix
  -- beyond what the provider itself shows; we never parse the key.
  key_last4              text,
  -- Name sent to POST /v1/keys: 'ronin-<user uuid, first 8>-<create intent id>'.
  -- ≤ 64 chars per contract. Identifies the user in the provider portal so an
  -- orphaned key (§3.4) can be found and deleted by hand.
  provider_key_name      text not null,
  -- Cumulative lifetime allowance WE believe the provider holds for this key:
  -- confirmed creates + confirmed top-ups − confirmed reductions. This is the
  -- figure reconciliation checks (§8); it is bookkeeping, not a balance.
  token_limit_issued     bigint not null default 0,
  -- Best provider-side usage observation (from reconciliation, §8).
  tokens_used_observed   bigint not null default 0,
  -- Last provider balance read + when (cache backing §7.1).
  balance_observed       bigint,
  balance_observed_at    timestamptz,
  status                 text not null default 'pending_create'
    check (status in ('pending_create','active','frozen','needs_attention','deleted')),
  -- Snapshot of the allowed_models decision at issuance (§3.2): the JSON array
  -- actually sent, or the string 'all' when the field was omitted (= all models).
  allowed_models         jsonb,
  -- Reserved for the out-of-scope per-key Claude provider override. Always NULL in Phase 2.
  claude_provider        text,
  -- v1→v2 conversion bookkeeping (§9): set in the same transaction that creates
  -- the conversion intent; converted_tokens is the frozen conversion amount.
  converted_at           timestamptz,
  converted_tokens       bigint,
  last_reconciled_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_upk_status on public.user_provider_keys (status, last_reconciled_at);
```

- The `unique` constraint on `user_id` is the one-key-per-user invariant, enforced by the database, not by worker discipline.
- `on delete cascade` is a last resort only: account closure deletes the provider key through the intent flow (§4.4) *before* any profile row could be removed.
- RLS posture (same as `risk_flags` / `handoff_codes`):

```sql
alter table public.user_provider_keys enable row level security;
revoke all on public.user_provider_keys from anon, authenticated;
grant all on public.user_provider_keys to service_role;
```

No end-user policy at all: browsers and the desktop host never touch this table directly; every read goes through the Node API, which is the only holder of the decryption key.

### 2.2 `public.key_issuance_intents` — durable intent rows

```sql
create table if not exists public.key_issuance_intents (
  id                     bigint generated always as identity primary key,
  user_id                uuid not null references public.users (id) on delete cascade,
  user_provider_key_id   bigint references public.user_provider_keys (id) on delete set null,
  kind                   text not null
    check (kind in ('create','topup','reduce','freeze','unfreeze','delete','convert')),
  -- For 'convert': the operation executed at the provider is create-or-topup,
  -- decided by the worker from whether a key row already has a ciphertext.
  source                 text not null
    check (source in ('claim','admin_charge','refund','suspend','reactivate','close','conversion','reconcile_fix')),
  -- Linkage back to the money event (exactly one is set, per source):
  order_id               bigint references public.orders (id) on delete set null,  -- claim approvals
  refund_id              bigint references public.order_refunds (id) on delete set null,
  -- The ledger idempotency key of the money event, e.g. 'order-approve:123'.
  ledger_idempotency_key text,
  -- Intent-level idempotency: unique. Formats in §3.1.
  idempotency_key        text not null unique,
  amount_tokens          bigint,   -- topup/convert amount; reduce: amount to remove
  target_token_limit     bigint,   -- reduce only: absolute limit to set (idempotent op)
  state                  text not null default 'pending'
    check (state in ('pending','in_flight','issued','confirmed','needs_attention','failed','cancelled','superseded')),
  attempt_count          integer not null default 0,
  attempts               jsonb not null default '[]'::jsonb,  -- §3.3 log shape
  -- Snapshots taken before an additive mutation (§3.4): the only evidence an
  -- admin gets when deciding whether an ambiguous top-up landed.
  balance_before         bigint,
  used_before            bigint,
  provider_http_status   integer,
  provider_error_code    text,
  actor                  text,   -- 'admin:<phone>' | 'system' | 'system:reconciler'
  next_attempt_at        timestamptz not null default now(),
  locked_at              timestamptz,   -- worker lease (§3.3)
  locked_by              text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz
);
create index if not exists idx_kii_drain on public.key_issuance_intents (state, next_attempt_at) where state in ('pending','in_flight');
create index if not exists idx_kii_user on public.key_issuance_intents (user_id, id desc);
-- At most one live create per user — the second line of defence after
-- user_provider_keys.user_id unique.
create unique index if not exists idx_kii_one_live_create
  on public.key_issuance_intents (user_id)
  where kind in ('create','convert') and state in ('pending','in_flight');
```

State machine (the brief's `pending → issued/topped_up → confirmed | needs_attention`, spelled out):

```
pending ──worker claims──▶ in_flight ──provider 2xx, response parsed──▶ issued ──local persist + verify──▶ confirmed
   │                          │
   │                          ├─ definitive 4xx (400/403/404/409 with known semantics) ─▶ failed (terminal; admin sees why)
   │                          ├─ ambiguous outcome (timeout, lost response, 5xx after dispatch) ─▶ needs_attention
   │                          └─ safe-retry failure (pre-dispatch validation, 429) ─▶ pending (backoff, attempt_count++)
   ├─ superseded by a newer intent (e.g. freeze lands while a create is queued → create is cancelled, §10 F-row 7) ─▶ cancelled / superseded
needs_attention ──admin resolution (§3.5)──▶ confirmed | superseded (replacement intent created)
```

`issued` is deliberately a separate state from `confirmed`: for a create, `issued` means "provider returned 201 and we hold the plaintext in memory"; the row becomes `confirmed` only after the ciphertext + fingerprint + `token_limit_issued` are persisted on `user_provider_keys`. A crash between the two leaves the key row in `pending_create` with an `issued`-or-`in_flight` intent — which the orphan procedure (§3.4) handles honestly instead of hiding.

### 2.3 Encryption at rest — exact scheme

- **Algorithm:** AES-256-GCM via Node `crypto.createCipheriv('aes-256-gcm', key, iv)`.
- **Key:** 32 bytes, base64-encoded, from the server env var **`CVC_KEY_ENCRYPTION_KEY`** (new; sits next to `CVC_PRIMARY_API_KEY` / `CVC_BASE_URL` in `server/.env`). Loaded in `server/src/config.js` as `cfg.cvcKeyEncryptionKey`. Startup validation: if Phase-2 routing is enabled (§11) and the value is missing or does not decode to exactly 32 bytes, the server **refuses to start the intent worker and the per-user proxy path** (fail closed for issuance; shared-key mode is unaffected). The key is never logged, never sent anywhere, never in the database.
- **Per-row material:** fresh random 12-byte IV per encryption (never reused — re-encryption on any write generates a new IV). AAD = `user_id || ':' || user_provider_keys.id` (binds ciphertext to its row; copying a ciphertext into another user's row fails authentication).
- **Stored format** (single `encrypted_key` text column, versioned):

```
v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
```

- **Decryption** happens only inside the Node server, in exactly three places: (a) the credential-delivery endpoint (§5.2), (b) the proxy's server-side injection path (§6.2), (c) server-side provider reads for balance/logs (§7). Plaintext lives only in a local variable for the duration of one operation; the reseller client module (§3.6) accepts it as an argument and never stores it.
- **Rotation:** the `v1:` prefix is the rotation hook. A future `v2` key would decrypt `v1` rows lazily and re-encrypt on next touch. Rotation is out of scope for Phase 2 but the format must not paint us into a corner.
- **Diagnostics:** anywhere a key must be referenced (logs, audit meta, admin UI), use `key_last4` / the row id only. The provider contract's "redact to a short prefix" rule applies to *provider-portal* diagnostics; our own surfaces show even less (last 4), which satisfies it.
- `key_fingerprint` (SHA-256 hex of the plaintext) exists for two jobs that must not require decryption: proxy delegated-key authentication (§6.2) and the **primary-key guard** (§3.6).

### 2.4 `public.key_usage_snapshots` — accumulated usage for panels + reconciliation

Provider logs are capped at 30 rows with no pagination and no per-request id (§8.1), so history must be accumulated by polling. One row per (key, poll) delta plus daily rollups:

```sql
create table if not exists public.key_usage_snapshots (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  user_provider_key_id bigint not null references public.user_provider_keys (id) on delete cascade,
  -- Poll bookkeeping: provider `total` log count seen at this poll, and how
  -- many of the newest rows were actually summed.
  logs_total_seen bigint not null,
  rows_summed     integer not null,
  tokens_summed   bigint not null,       -- sum of cost_tokens over rows_summed
  partial         boolean not null default false,  -- true when total delta > 30 (rows lost)
  balance_after   bigint,                -- GET /v1/balance observed at the same poll
  polled_at       timestamptz not null default now()
);
create index if not exists idx_kus_user_time on public.key_usage_snapshots (user_id, polled_at);

create table if not exists public.key_usage_daily (
  user_id     uuid not null references public.users (id) on delete cascade,
  day         date not null,             -- Asia/Tehran day, matching panel charts
  model       text not null,
  requests    integer not null default 0,
  cost_tokens bigint not null default 0,
  partial     boolean not null default false,  -- day contains a partial poll
  primary key (user_id, day, model)
);
```

Dedup/last-seen cursors (`logs_total_seen`, last log timestamp + composite hash of the newest row seen) live on `user_provider_keys` via two added columns: `logs_total_seen bigint not null default 0` and `logs_newest_hash text`. (Folded into the §2.1 CREATE in the real migration; called out here so the reconciliation section can reference them.)

RLS for both tables: enabled, revoked from `anon`/`authenticated`, granted to `service_role` — identical posture to §2.1.

### 2.5 Small amendments bundled in migration 00007

- `ledger.kind` check gains **`'convert'`** (pattern from migration 00004's refund amendment). Conversion posts a `delta_tokens = 0` marker row (§9) — the balance arithmetic of the append-only ledger is untouched.
- `risk_flags.kind` needs no schema change (free text); Phase 2 introduces the reserved kinds `provider_drift` and `provider_key_attention`, created with `created_by = 'system:reconciler'` / `'system:issuance'`.
- A settings document seeds nothing; the routing flag (§11) is a `public.settings` row with key `subscription_routing`, created by the admin endpoint on first write and defaulted in code to `{ "mode": "shared" }` when absent — the same read-through pattern as `getSetting` in `server/src/settings.js`.


---

## 3. Issuance wiring

### 3.1 Where the intent is created

**Rule: the provider is never called inside, or synchronously after, the approval transaction — but the intent row is created as close to the money event as possible, and a sweeper guarantees it eventually exists.**

`approve_claim` (migration 00002) is **not modified**. It already gives us the two properties issuance needs: atomicity of the money event, and an idempotency anchor (`order-approve:<orderId>` in the ledger). The flow in `server/src/orders.js#reviewOrder` becomes:

1. `approve_claim` commits exactly as today. Approval **cannot** fail because the provider is down — the provider is not involved yet. The purchase is never lost: the ledger grant + approved order are the durable record.
2. **Immediately after commit, in the same admin request**, if routing mode (§11) is not `shared`, the server inserts the issuance intent:
   - If the user has no `user_provider_keys` row (or a row with no ciphertext): `kind='create'`, `source='claim'`, `amount_tokens = grantedTokens` returned by the RPC.
   - Else: `kind='topup'`, `amount_tokens = grantedTokens` (partial approvals credit proportionally inside the RPC today, so `grantedTokens` is already the right number).
   - `idempotency_key = 'claim-issuance:<orderId>'` — unique constraint makes a double insert a no-op conflict, which is swallowed deliberately.
   - The insert also ensures the `user_provider_keys` shell row exists (`status='pending_create'`, `provider_key_name` precomputed) so the one-key invariant is visible from the first purchase.
3. If step 2 itself fails (DB hiccup, process crash between commit and insert): the admin still gets a successful review response (the money event succeeded), the failure is logged (`issuance_intent_insert_failed`, order id + user id only), and the **backfill sweeper** (§3.3) repairs it: every 60 s it anti-joins approved orders (and refunds, manual charges, conversions) against `key_issuance_intents` on the deterministic idempotency keys and inserts any missing intent. This anti-join — not the inline insert — is the actual guarantee; the inline insert is just latency optimisation.
4. The admin review response gains `issuance: { state: 'pending' | 'not_applicable' }` so the admin panel can show "provider key: provisioning queued" without implying the money is at risk.

The same post-commit + sweeper pattern is used by **every** intent producer (§4): suspend/reactivate/close, refunds, manual charges, conversion. Producers never call the provider; they only insert intents.

### 3.2 The create call

Worker executes a `create` intent:

1. Re-read the user + key rows under the intent lease. If the user now has a ciphertext (a racing create succeeded), mark this intent `superseded` and stop.
2. Build the request:
   - `name`: the precomputed `provider_key_name` (`ronin-<uuid8>-<intentId>`, §2.1).
   - `token_limit`: `amount_tokens` (the pack's granted tokens; for a conversion-create, the frozen conversion amount; if a create and an already-queued top-up both exist, the worker may coalesce — see §3.3).
   - `allowed_models`: **omitted**. Contract semantics: empty/omitted = all models available to the account — which *is* "the full account catalog", and it stays correct when the catalog changes. (Sending the explicit 44-id list from `docs/model-catalog.json` was considered and rejected: it would silently exclude future models and create a permanent models-sync burden. Recorded as a resolved ambiguity, §13 A5.) The decision is snapshotted as `allowed_models = '"all"'` on the key row.
3. `POST {CVC_BASE_URL}/v1/keys` with the primary key (§3.6). On `201`: capture `key` (plaintext, memory only) + `meta` (`token_limit`, `tokens_used`, `is_active`) → encrypt (§2.3) → one DB transaction writes ciphertext, fingerprint, last4, `token_limit_issued = meta.token_limit`, `status='active'`, and flips the intent `issued → confirmed`. Verify `meta.token_limit` equals the requested limit; a mismatch marks the intent `needs_attention` (money-relevant discrepancy, human eyes) but the key stays usable.
4. Any non-201 outcome goes through the failure classification in §3.4. **A create is never auto-retried after an ambiguous outcome** (§3.4).

### 3.3 The worker

- **Where:** in-process in `server/src/server.js`, following the existing expiry-sweep precedent (`void sweep(); setInterval(sweep, 6h).unref()`). New module `server/src/reseller/worker.js`: a 15-second drain loop + an immediate kick function exported for producers to call after inserting an intent (so the common case provisions in ~1 s, not 15 s).
- **Claiming:** intents are claimed with `UPDATE … SET state='in_flight', locked_at=now(), locked_by=<instance id> WHERE id = (SELECT id … WHERE state='pending' AND next_attempt_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)` — safe if the API is ever scaled to more than one process, and a crashed worker's lease expires after 120 s (`in_flight` rows with an old `locked_at` are reclaimable — **except** that reclaiming a mutation intent whose provider outcome is unknown routes it to the ambiguous path in §3.4, never straight back to execution).
- **Ordering:** per user, intents execute strictly in `id` order (a top-up queued behind an unexecuted create waits; a freeze jumps the queue — it is state-setting, idempotent, and safety-relevant — and a pending create for a now-suspended user is `cancelled` instead, §10 row 7).
- **Coalescing (safe case only):** if a `create` is `pending` (never dispatched) and one or more `topup`s for the same user are also `pending`, the worker folds the top-up amounts into the create's `token_limit` and marks the top-ups `superseded` (with `attempts` noting the fold). Folding is only allowed *before first dispatch* — after dispatch, no arithmetic is ever rewritten.
- **Attempt log:** each dispatch appends to `attempts` a JSON object `{ at, action, httpStatus, errorCode, durationMs, note }` — status and codes only, **never** request/response bodies, never key material (contract mutation-safety checklist, item 6). The array is capped at the last 20 entries.
- **Backoff:** safe-retry failures (§3.4) reschedule with `next_attempt_at = now() + min(2^attempt_count × 30 s, 30 min)` + jitter. `429` honours the provider's `Retry-After` when present.
- **Backfill sweeper** (§3.1 step 3) runs in the same loop every 60 s.

### 3.4 Failure classification and the reconcile-before-retry rule

The contract's rule — *never automatically retry a state-changing request after an ambiguous timeout* — is implemented as a classification every mutation outcome must pass through:

| Outcome | Class | Behaviour |
|---|---|---|
| 2xx with parseable body | **confirmed success** | Persist result, intent → `confirmed`. |
| Error before dispatch (local validation, DNS/connect refused before bytes sent — only where the client can prove non-dispatch) | **safe retry** | Back to `pending` with backoff. |
| `429` | **safe retry** | `pending` + `Retry-After`/backoff. No state changed server-side per contract error table. |
| `400` | **terminal** | Intent → `failed`; admin sees the provider `error.code`. Fix is a new intent, never a retry of the same payload. |
| `401` / `403` on a control-plane call | **terminal + alarm** | Means our credential is wrong or not primary. Intent → `failed`, `admin_audit` row `provider_control_plane_auth_failed`, worker pauses **all** issuance (a config-level circuit breaker) until an admin re-enables it. Retrying cannot help and could mask a primary-key incident. |
| `404` on edit/delete of a target key | **state-dependent** | For `delete`: treat as success (already gone) → `confirmed`. For freeze/unfreeze/topup: intent → `needs_attention` (our stored key disagrees with the provider's world). |
| `409` | **terminal** | Per contract: state conflict (e.g. topping up an unlimited key, primary-replacement problem). Should be unreachable for delegated keys if the primary guard (§3.6) holds; → `failed` + audit. |
| Timeout / connection reset / `500` / `503` **after dispatch** | **AMBIGUOUS** | **Never auto-retry the mutation.** Intent → `needs_attention` (for additive ops) or reconcile-read first (for state-setting ops, below). |

**Reconcile-before-retry, per kind:**

- **`create` — the honest hard case.** If the response is lost, we hold *no key id and possibly no plaintext*: the contract has **no list-keys endpoint and no get-key endpoint** (unlike the OpenRouter blueprint, where keys are addressable by hash). A created-but-unacknowledged key is therefore **undetectable and unrecoverable through the API**. Design response:
  1. The intent goes to `needs_attention` immediately; the worker never re-dispatches a create for that user.
  2. The user is **not** blocked forever and never double-charged: their ledger record is intact, and an admin resolves the incident (§3.5) by issuing a *replacement* create (new intent, new provider key name with the new intent id). The user's allowance is then exactly their purchased total on the replacement key.
  3. The orphaned key, if it exists, wastes only aggregate account capacity (the sum of key limits draws from account capacity) and can never be spent — nobody holds its plaintext. It is identifiable in the provider portal by its `provider_key_name` (`ronin-<uuid8>-<intentId>`) and the runbook (§3.5) has the owner delete it there. A periodic capacity watch (§8.5) alerts if aggregate orphaned capacity ever becomes material.
  4. Mitigations that shrink the window: mutations get a short client timeout (10 s), the intent is durably `in_flight` *before* dispatch, and on a 201 the ciphertext persist happens in the same handler before any other work (§3.2 step 3). The residual crash window (201 received, process dies before DB write) is the same orphan case and follows the same path — it is priced in, not hidden.
- **`topup` (`additional_tokens`) — additive and non-idempotent.** Before dispatch, the worker snapshots `balance_before` / `used_before` on the intent (from a fresh balance read + the accumulated usage tracker, §8). After an ambiguous outcome:
  1. **No automatic retry, ever.** Intent → `needs_attention`.
  2. The admin resolution view (§3.5) shows: amount, snapshots, a *fresh* balance read and recent logs. Heuristic the UI surfaces (but never acts on alone): if `balance_now − balance_before ≈ amount` (within the usage the logs show for the window), the top-up almost certainly landed.
  3. The admin picks exactly one, each audit-logged: **Mark applied** (intent → `confirmed`, `token_limit_issued += amount`, no provider call) or **Retry top-up** (explicit human confirmation re-dispatches *once*; the double-add risk is now a named human decision, and if it double-adds, reconciliation (§8) will show provider limit above our ledger and the corrective op is a `reduce` to the absolute correct limit — which *is* idempotent) or **Escalate** (leave in `needs_attention`).
- **`reduce` (absolute `token_limit`) — idempotent by contract.** Repeating the same absolute reduction is safe, so ambiguous outcomes *may* auto-retry (bounded, with backoff). The target is computed before dispatch and stored (`target_token_limit`); a retry sends the stored target, never a recomputed one. Floor rule: target is never below the latest observed `tokens_used`; if observed usage already exceeds the intended target, the worker clamps, records the clamp in `attempts`, and raises a `provider_drift` heads-up (§8) — a refund that cannot fully claw back spent tokens is a known, visible state, not a silent failure.
- **`freeze` / `unfreeze` (`active` flag) — state-setting, idempotent in effect.** Ambiguous outcome → reconcile-read first: attempt a balance read with the delegated key and inspect behaviour, then re-dispatch at most twice with backoff (a duplicate freeze/unfreeze is harmless). Local `user_provider_keys.status` is only flipped on a 2xx; until then the admin UI shows "freeze pending/unconfirmed", while the *effective* block for a suspended user is already enforced by our own auth layer (§4.2) — provider freeze is defence-in-depth, not the only wall.
- **`delete` — irreversible but idempotent in effect.** Ambiguous outcome → retry is safe: a second delete returns `404`, which §3.4 already treats as success. Explicit admin confirmation for the exact target is required before the *first* dispatch (contract rule), captured in the close flow (§4.4).

### 3.5 Admin surface for `needs_attention`

- Admin API: `GET /admin-api/provider/intents?state=needs_attention` (cap `finance_view`) and per-user `GET /admin-api/users/:id/provider-key` (§7.2) includes that user's attention intents. Resolution actions are **owner-only** (mirroring claim approval's `requireOwner`): `POST /admin-api/provider/intents/:id/resolve` with `{ decision: 'mark_applied' | 'retry_once' | 'create_replacement' | 'abandon' }`, CSRF-protected, `admin_audit` action `provider_intent_resolved` with the decision + intent id (no key material).
- User dossier shows a red attention banner when any intent for the user is `needs_attention`, with kind, amount, age, attempt log, and the balance evidence for top-ups.
- An open `needs_attention` intent also raises a `risk_flags` row (`kind='provider_key_attention'`, `created_by='system:issuance'`) so it appears in the existing open-flags count on the dossier and in analyst context; resolving the intent auto-resolves the flag.
- Runbook (in the doc's ops appendix, §14): orphan cleanup in the provider portal by key name; pool-capacity check; what to do if `mark_applied` evidence is inconclusive (default = escalate, not guess — money correctness rule).

### 3.6 Reseller client module + the primary-key guard

New module `server/src/reseller/client.js` — the only place that talks to the control plane:

- Config: `cfg.cvcBaseUrl` (env `CVC_BASE_URL`; fallback `https://cheapvibecode.ru` per contract, `https://ru.cheapvibecode.ru` is the known origin — the env value wins and is never hard-coded over), `cfg.cvcPrimaryApiKey` (env `CVC_PRIMARY_API_KEY`). Both referenced by env-var name in code and docs; **values are never logged, returned, or written anywhere** (this document included).
- Methods: `createKey({ name, tokenLimit })`, `editKey({ key, ...fields })` (used for top-up / reduce / freeze / unfreeze / delete), `getBalance(delegatedKey)`, `getLogs(delegatedKey)`. Auth: `Authorization: Bearer …` per contract.
- Timeouts: 10 s mutations, 8 s reads (AbortController). **No internal retries for mutations** — retry policy lives in the worker (§3.4) where the classification is. Reads may retry twice with jitter on 429/503.
- Error surface: returns `{ status, code }` from the provider's `{ error: { code, … } }` envelope; branching is on status + `error.code`, never on message text (contract rule).
- **Primary-key guard (defence in depth, contract-critical):** the provider *promotes another key* if the primary is frozen/deleted — freezing or deleting the primary would be catastrophic and weird. Before any `editKey` dispatch, the client asserts the target is a delegated key: (a) the target fingerprint must exist in `user_provider_keys` (targets only ever come from our rows — the API of this module takes a *key-row id*, not a raw key string, everywhere except create), and (b) `sha256(target) !== sha256(cfg.cvcPrimaryApiKey)` computed in memory. If either check fails, the call throws before dispatch and writes `admin_audit` `provider_primary_guard_tripped`. There is no code path in Phase 2 that edits, freezes, or deletes the primary key, and the primary key is never stored in `user_provider_keys`.
- Keys are **opaque**: the code never parses prefixes (`sk-ronin…` or any other), never branches on them. Prefix knowledge is used nowhere; the portal-set prefix is a display property only.

---

## 4. Freeze / unfreeze / delete and the other money mirrors

### 4.1 Mapping table (existing action → Phase-2 effect)

| Existing action (code) | Today | Phase 2 addition |
|---|---|---|
| Claim approved — `reviewOrder` approve (`orders.js`), RPC `approve_claim` | Ledger grant + lot | Post-commit `create`/`topup` intent (§3.1). RPC unchanged. |
| Claim rejected | Status + reason | Nothing at the provider. |
| Suspend — `POST /admin-api/users/:id/toggle-active {isActive:false}` (cap `risk_manage`) | `is_active=false`, `logoutAll` | + `freeze` intent (`source='suspend'`) if a key exists. |
| Reactivate — same route `{isActive:true}` | `is_active=true` | + `unfreeze` intent (`source='reactivate'`). |
| Account closure | **Does not exist** (§13 C2) | **New** owner-only flow (§4.4) ending in a `delete` intent. |
| Refund — `POST /admin-api/orders/:id/refund` → `refund_order` RPC | Ledger debit (proportional, capped) | + `reduce` intent for `tokensRemoved` (`source='refund'`, idempotent absolute op, §3.4). |
| Manual charge — `POST /admin-api/users/:id/charge` → `adjust_credit` | Ledger grant/debit with mandatory note | Positive → `topup` intent (`source='admin_charge'`); negative → `reduce` intent. |
| Conversion (§9) | — | `convert` intent (`source='conversion'`). |

All additions follow the identical recipe: the existing transaction commits first; the intent is inserted post-commit with a deterministic idempotency key (`suspend:<userId>:<audit-ish epoch>` uses the admin action's own audit row id where one exists; refunds use `refund:<refundId>`; charges use the resulting ledger entry id: `adjust:<ledgerId>`); the sweeper backfills any miss by anti-join. Toggling an already-suspended user, double refunds (RPC-idempotent), and replayed charges therefore cannot double-issue intents.

### 4.2 Suspension semantics

- Immediate effect (unchanged, already true today): `authenticate()` rejects inactive users and `logoutAll` revokes every device — the user's app and panels stop working at once, independent of the provider freeze.
- Provider freeze follows asynchronously via the intent. While a freeze is unconfirmed, the residual exposure is a *leaked or cached delegated key used outside our proxy* — which is exactly what the freeze closes. The admin dossier shows key status `frozen` only after provider confirmation; before that, `freeze requested` (intent state) is displayed.
- A `pending` create/topup for a user who gets suspended is `cancelled` by the worker (§3.3 ordering) — we never provision allowance for a suspended account. On reactivation, the admin re-approves nothing; the sweeper re-creates intents for any approved-but-unissued amounts it finds via the anti-join (they were cancelled, so the sweeper's idempotency keys get a `:retry<n>` suffix recorded in `attempts`). Simpler alternative the design also accepts: cancelled intents keep their idempotency key and the reactivation handler inserts fresh intents for the user's unissued approved total (computed as ledger purchase total − `token_limit_issued` − live intents), which is self-healing by construction. The latter is the specified behaviour.

### 4.3 Reactivation

`unfreeze` intent; on confirmation `user_provider_keys.status` returns to `active`. If the key was deleted (post-closure the account cannot be reactivated at all — closure is terminal in the UI), no unfreeze is attempted.

### 4.4 Account closure (new flow, existing patterns)

Because no closure exists today (§13 C2), Phase 2 specifies one built entirely from existing patterns:

- Route: `POST /admin-api/users/:id/close` — **owner-only** (`requireOwner`, like claim approval), CSRF-protected, body `{ confirmPhone: <user's phone> }` (typed-confirmation pattern), mandatory `note`.
- Effects, in order: (1) `is_active=false` + `logoutAll` (the suspend machinery); (2) insert `delete` intent (`source='close'`) — the worker requires the intent to carry the admin's confirmation marker (the audit row id from step 3) before dispatch, satisfying the contract's explicit-confirmation rule for delete; (3) `admin_audit` action `user_closed` with the note.
- The profile/ledger rows are **retained** (financial record; `users` row is not deleted — "closure" in Phase 2 means deactivated + key deleted + sessions revoked). Hard profile deletion is a separate GDPR-style decision, out of scope.
- On delete confirmation: `user_provider_keys.status='deleted'`, ciphertext + fingerprint are **wiped** (set NULL) — after deletion there is no reason to retain a spendable secret, and wiping shrinks the blast radius of any future DB leak. `token_limit_issued` and history stay for audit/reconciliation.

### 4.5 Refunds and manual charges at the provider

Covered by §4.1's `reduce`/`topup` intents. Two money notes:

- A refund's provider reduction can lag the ledger debit (intent queue). During the lag the user could spend tokens the ledger says were refunded. Mitigation: the proxy (§6) checks local key status but not per-request ledger state (that would resurrect metering) — so the design accepts a small, bounded lag (worker kick makes it seconds in the normal case) and the dossier shows "refund: provider reduction pending" until confirmed. For large refunds the admin can also freeze the key first (existing suspend action) — the runbook recommends freeze-then-refund for refunds above one pack.
- Manual *debits* have the same shape via `reduce` (floor rule §3.4 applies).


---

## 5. Key delivery to the host

### 5.1 The constraint (from §1.3)

The engine sends one Bearer credential to the proxy. Today it is the session access token and the proxy authenticates it as a session. Phase 2 needs the *delegated key* to be what ultimately reaches the provider, and the brief requires the host to obtain that key over the existing authenticated session channel — recoverable on a new device login, because the provider shows the plaintext exactly once and **our encrypted store (§2.3) is therefore the only source**.

### 5.2 Delivery endpoint

New user-API route (in `server/src/app.js`, behind the existing `requireUser` = `auth.authenticate`):

```
GET /api/subscription/credential
→ 200 { routingMode: 'per_user',
        keyStatus: 'active' | 'frozen' | 'pending_create' | 'needs_attention' | 'none',
        delegatedKey: '<plaintext>',        // only when keyStatus = 'active' (or 'frozen', see below)
        tokenLimitIssued: 50000000,
        issuedAt: '…' }
→ 200 { routingMode: 'shared' }             // flag off: no key material, host uses v1 path
```

Rules:

- Authenticated with the session token exactly like every other user route; the device-registry check inside `authenticate()` applies, so a revoked device cannot fetch the key. Suspended users get the existing `account_disabled` failure from `authenticate()` — they never receive the key (a frozen key's plaintext is not delivered; `keyStatus:'frozen'` returns **without** `delegatedKey`).
- Response headers `Cache-Control: no-store`; the body is never logged (the server's structured logger already logs codes/metadata only — the endpoint is added to the log-redaction review list in the test plan, §12).
- Rate-limited per user (reuse `requireRateLimit`, e.g. 30/hour) — generous for legitimate re-logins, hostile to scraping.
- The host calls it (a) right after OTP/handoff login completes, (b) after every successful `revalidate()` that reports `routingMode:'per_user'` with a changed `keyStatus`/limit, and (c) on demand when a subscription turn fails with a key-shaped error (§6.4). New device login therefore recovers the key with no user action — the "shown once" problem is fully absorbed by the encrypted store.

### 5.3 What the host stores locally

- `AuthManager` (host `auth.js`) gains the delegated key as a **separate field of the existing `CredentialStore`** record in `credentials.json` (`subscriptionKey`), persisted through the same `writeJsonFile0600` path. It is *not* written to `auth.json` (that file is BYOK keys; mixing credential domains would let BYOK UI surfaces — masked-key lists, provider settings — accidentally treat the delegated key as user property) and never to `config.json`, `localStorage`, or the GUI.
- The `CredentialStore` interface is unchanged, so the planned Windows Credential Manager swap covers the delegated key with no extra work.
- Cleared on: logout / session-clear (`_clearSession` already wipes the store record), account-disabled revalidation, device revocation, and whenever a credential fetch returns `keyStatus` in (`deleted`, `none`) or a different key (rotation/replacement after an orphan incident — compare fingerprint locally by hashing; store the fingerprint beside the key for change detection, never the plaintext's prefix).
- GUI visibility: Settings shows only a masked form (`••••` + last 4, reusing `maskedKey` in host `config.js`) and the key status. There is no "copy key" affordance — the key is a machine credential, not a user asset, in the product's UX.
- `buildSubscriptionAttempt` (host `router.js`) changes: in per-user mode `resolveApiKey` returns the stored delegated key (fetching via §5.2 first if absent); in shared mode it returns the session token exactly as today. The host learns the mode from the `/api/account-status` payload (§7.1 adds `routingMode`), cached alongside the subscription state in `AuthManager`.

### 5.4 Why the host holds the key at all (and the residual risk)

Holding the key on the device means a leaked key is spendable until frozen — bounded by that user's own remaining allowance, which is precisely the blast radius the reseller model is designed around (and the reason suspension has a provider-side freeze, §4.2). The alternative (proxy-only custody, §6.2 path B) keeps the key server-side but makes the *session token* a de-facto unlimited subscription credential for the proxy. The design supports both custody paths in the proxy (§6.2) and defaults to host-held delivery per the brief; the flag (§11) can switch custody without a data migration because the encrypted store is the source either way.

---

## 6. The thin relay — `server/src/proxy.js`

### 6.1 What gets deleted (per-user mode)

- `reserveHold` / `commitHold` / `releaseHold` and the whole Hold/Commit lifecycle, including the `holds`-table idempotency replay (the provider + engine retries own that concern now; see §6.5).
- The shared upstream key for subscription users: `cfg.upstreamApiKey` is no longer consulted on the per-user path.
- Server-side metering math: `estimatePromptTokens`, `actualCost`, multiplier-based reservation. The settings multiplier table remains for *display* (panels/model picker show coefficients as today) but no longer decides charges — the provider's coefficients do. (Product note: catalog coefficients were sourced from the provider, so displayed and charged coefficients agree at issuance time; drift between our catalog and the provider's live pricing is a catalog-sync concern, flagged in §13 A6.)
- SSE usage parsing for settlement. The stream is piped through untouched.

What is **kept**: the route (`POST /v1/chat/completions` in `app.js`), authentication, the admin model-enabled check (`getModelEntry` — a disabled model is still refused before any provider call), per-user rate limit + concurrency cap (`ratelimit.js`, the in-flight map), body size cap, streaming and buffered passthrough, and the error-envelope shape (`{ error: { code, message } }`) the host already parses.

### 6.2 Request flow (per-user mode)

1. Route authenticates. **Dual-auth:** (A) session Bearer → `auth.authenticate` as today; the proxy then loads the user's key row and decrypts (§2.3) server-side. (B) delegated-key Bearer (what the host sends once it holds the key, §5) → the proxy hashes the presented key (SHA-256), looks up `key_fingerprint`, loads the user, and applies the same `is_active` + device-independent checks. Path B exists so the forwarded credential and the authenticated credential are the same secret (no session token ever travels upstream, and no second credential needs inventing). Both paths converge on `{ user, delegatedKeyPlaintext }`; path A is also the panels/testing path.
2. Local key-state gate: row missing → `503 provider_key_not_ready` (provisioning pending; host shows a "setting up your key" transient, **not** the credit banner). `status='frozen'` or user inactive → `403 account_suspended` (§6.4). `needs_attention` → the key may still be valid; proceed (issuance incidents must not take a working key offline) but log.
3. Model-enabled check; Fast translation: the host signals Fast via header `x-ronin-fast: 1` (engine) — the relay converts it to the provider's contract mechanism, body field `service_tier: 'priority'`, and strips any `ronin_fast` body field (Ronin control fields never leak upstream). All other body fields pass through verbatim.
4. Forward: `POST {CVC_BASE_URL}/v1/chat/completions` with `Authorization: Bearer <user's delegated key>`, `Content-Type: application/json`. The provider endpoint is constructed server-side from `cfg.cvcBaseUrl`; the host and panels never learn it (§6.3).
5. Response: status + body streamed/buffered back verbatim, minus provider-identifying headers (§6.3). No usage parsing, no DB writes on the hot path (an async, best-effort "last used" touch on the key row at most, throttled to 1/min/user).

### 6.3 Header / secret hygiene

- Incoming `Authorization` is **always** replaced, never forwarded blindly: path A discards the session token after auth; path B forwards the validated delegated key. Cookies and `x-ronin-*` headers are stripped (except the consumed Fast signal). Nothing about the Ronin session reaches the provider.
- The primary key is **never** present in this module — it lives only in the reseller client (§3.6). The relay cannot leak what it never holds.
- Response headers from the provider are allow-listed (`content-type`, `retry-after`, request-id if present); `server`, `via`, and any provider-branding headers are dropped, mirroring the endpoint-secrecy posture: the app binary contains only the Ronin server URL.
- Logging: model, status, latency, token counts *if the provider returns a usage object* (opportunistic, for analytics continuity §7.4) — never prompts, never keys, never full bodies (same posture as the current structured logger).

### 6.4 Error mapping (provider → Ronin → host/GUI)

| Provider | Relay returns | Host (`classifyProxyError`) | GUI |
|---|---|---|---|
| `402` (allowance or pool exhausted) | `402 { code: 'insufficient_credit' }` — the existing envelope via `paymentRequired()` | `insufficient_credit` (unchanged: 402 match) | Existing `credit` banner ✓ |
| `401` (key invalid/revoked at provider) | `502 { code: 'provider_key_invalid' }` + raise `provider_key_attention` flag + intent to re-issue is **not** auto-created (human first) | generic turn error; host also triggers a credential re-fetch (§5.2c) | Generic error + support hint |
| `403` from provider on a delegated key (shouldn't happen — delegated keys aren't primary; means reseller-access anomaly) | `502 { code: 'provider_forbidden' }` + control-plane alarm (§3.4) | generic | Generic error |
| Local frozen/suspended (§6.2 step 2) | `403 { code: 'account_suspended' }` | **Requires a one-line host change:** `classifyProxyError` must match `account_suspended` → a new kind mapped to the existing `subscription_locked` handling. (Today 403 maps to `model_disabled` — flagged in §13 C5; the design specifies the host change rather than overloading 402, which would lie to the user about credit.) | Existing `locked` banner |
| `404` model not found / key's model policy | Pass through status + sanitised body | generic | Generic error |
| `429` | Pass through + `Retry-After` | engine retry/failover semantics unchanged | — |
| `500/503` / network failure | Pass through (or `502 upstream_unreachable`, matching the current code's naming) | failover-eligible as today | Generic error |
| Model disabled by admin (local check) | `403 { code: 'model_disabled' }` (unchanged) | `model_disabled` ✓ | Existing message ✓ |

### 6.5 Idempotency after Hold/Commit

The v1 proxy de-duplicated retries via stored responses. In per-user mode, a client retry of a completion is a *new provider request billed by the provider* — there is no contract mechanism to dedupe upstream (no idempotency key in the provider's runtime API). The engine's own retry policy (`maxRetries: 2` in host `engine.js`) already existed under v1 for BYOK; subscription turns inherit it. This is a deliberate, documented behaviour change: exactly-once *billing* is now the provider's model, and the design does not fake a guarantee the contract doesn't offer.

### 6.6 Shared-mode path

Under `mode='shared'` (§11) the current `proxy.js` behaviour runs verbatim — Hold/Commit, shared key, ledger metering. The two paths share the route and auth; the branch is one `if` on the resolved routing mode per request. Deleting the v1 path is a *post-rollout* cleanup decision, not part of Phase 2.

---

## 7. Balance & usage reads; panel changes

### 7.1 Balance

- Source: `GET /v1/balance` with the user's delegated key (server-side call; §8.2 discusses the semantics ambiguity and why balance is a *display* figure, never a money input).
- Cache: on `user_provider_keys` (`balance_observed`, `balance_observed_at`). TTL **60 s**: reads within TTL serve the cache; reads past TTL refresh synchronously with an 800 ms soft deadline — on timeout/failure serve stale (flagged) rather than failing the panel. Stale is acceptable for display for up to 24 h; beyond that the panels show "balance unavailable" instead of a number (a wrong number is worse than none — money rule).
- Surfaces:
  - `GET /api/account-status`: in per-user mode, `balanceTokens`/`spendableTokens` are both set from the provider balance cache (there is no longer a holds distinction), and the payload gains `routingMode`, `providerKey: { status, tokenLimitIssued, balanceStale }`, and `lots: []`. The host's `AuthManager._cacheSubscription` tolerates the new fields without changes (it picks named fields); the GUI header balance keeps working because the field names are preserved.
  - `GET /api/me` and `GET /api/credits`: same substitution when in per-user mode; the ledger portion of `/api/credits` still returns the purchase history (that *is* the user's receipts view), while `balanceTokens` comes from the provider cache. In shared mode everything is byte-identical to today.
- Balance is **never** used to grant, debit, or reconcile money (§8.2) — display and heuristics only.

### 7.2 User panel

- Dashboard: balance card reads the provider-backed balance (§7.1). Usage aggregates switch source (§7.3).
- New server endpoint: `GET /api/usage/recent` → the server calls `GET /v1/keys/logs` with the user's key and returns:

```json
{ "rows": [ { "model": "…", "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0,
              "costTokens": 0, "fast": false, "status": "success",
              "createdAt": "…" } ],
  "totalRequests": 47, "windowNote": "recent_30" }
```

- UI copy must say what the data is: the History screen shows **"most recent 30 requests"** (the contract's hard cap) with the all-time request count beside it. It must not present the list as complete history. Longer history comes from our daily rollups (§7.3) in aggregate form, not per-request form.
- Buy/purchases screens: unchanged (packs, receipt upload, claim status). After an approval, the purchase row can show "key topped up" once the intent confirms — driven by a new `issuanceState` field on `GET /api/orders` (joined from intents by order id); a `needs_attention` issuance shows "being finalised — your purchase is safe" copy, never an error state (the purchase *is* safe; §3.1).

### 7.3 Usage aggregates after `consume` rows stop

`deriveUsage` (user panel) currently aggregates ledger `consume` rows; per-user mode writes none. Replacement: server endpoint `GET /api/usage/summary` returning the existing `UsageSummary` shape (`todayTokens`, `monthTokens`, `last7Days`, `topModels`), computed from `key_usage_daily` (§2.4) — which the reconciliation poller (§8) maintains. The panel's live API client switches `usageSummary()` to this endpoint in per-user mode; shared mode keeps `deriveUsage`. Honest limitation, shown in UI footnote: daily figures are built from polled provider logs and are a **lower bound** on days marked `partial` (§8.1); the footnote appears only when a partial day is in range. History before a user's conversion date does not exist in rollup form (their v1 history stays visible via the ledger in `/api/credits`).

### 7.4 Admin panel — per-user key section

In the user dossier (`UserDetailScreen.tsx`), a new **Provider Key** card beside the lots card, fed by `GET /admin-api/users/:id/provider-key` (cap `finance_user` for reads):

- From our DB: status, `token_limit_issued`, `tokens_used_observed`, last balance + its age, `converted_at/tokens` if any, open drift/attention flags, and the **top-up history** — the user's intent list (`kind`, `amount_tokens`, `source`, state, timestamps, actor) cross-referenced with claim ids. This is the audit-grade history (provider logs are not history, §8.1).
- Live reads (button, cap `finance_user`): `POST /admin-api/users/:id/provider-key/refresh` → fresh balance + logs fetch, updates the cache/snapshot, returns both. This is also the manual reconciliation trigger for one user (§8.3).
- Actions (cap `risk_manage`, CSRF, audit-logged — same guard pattern as device revoke): **Freeze** / **Unfreeze** buttons (insert intents; disabled when one is already in flight), and a link into `needs_attention` resolution (§3.5, owner-only actions).
- Analyst context (`analytics.js`): add `{ providerKeys: { active, frozen, needsAttention, openDriftFlags }, poolBalanceObserved }` so the on-demand analyst can answer pool/drift questions. `analyticsOverview`'s ledger-based totals remain the *financial* truth (purchases), with a new `providerTokensUsedObserved` total alongside — labelled as observed, not booked.

---

## 8. Reconciliation

### 8.1 What the contract actually lets us know

Be precise about the observability ceiling:

- `GET /v1/keys/logs` (auth: the delegated key itself): newest **30** rows, newest-first, **no pagination, no per-key parameter, no request id**. Fields: model, reasoning_effort, fast, input/output/cached tokens, **`cost_tokens`** (the billed figure), latency, status, `created_at`; plus `total` = all-time log count for the key.
- `GET /v1/balance` (auth: the delegated key): one number — see §8.2.
- Create responses include `meta.tokens_used` (0 at birth). **Edit responses carry no usage figure** in the contract (only delete's `{status:'deleted'}` is specified). There is **no get-key / list-keys endpoint**.
- Therefore: exact provider-side `tokens_used` is *never directly readable* after creation. Anyone designing a drift check that assumes it is, is designing fiction. The check below is built only from logs + balance + our own issuance ledger.

### 8.2 The balance ambiguity — safer interpretation chosen

Contract wording: balance returns *"tokens available after customer balance and key allowance are combined."* Two readings: (a) `min(key allowance remaining, account pool remaining)` — the spendable truth; (b) something additive/pooled that could **overstate** what this key can actually spend (e.g. if the pool is shared, the number might reflect more than the key's own cap in some states, or less in others).

**Chosen interpretation (money rule): treat `/v1/balance` as an upper bound on the key's remaining allowance, never as the remaining allowance itself.** Consequences:

- Display: fine to show (if it overstates, it overstates in the user's favour visually but the provider will still 402 at the real cap — the app already handles 402; if it understates due to pool pressure, showing it is *accurate* about spendability).
- Reconciliation: balance may only be used in an inequality (§8.3), never an equality.
- Pool exhaustion (primary account balance drained) makes **every** key read low / 402 despite healthy individual allowances — §8.5 handles this as a pool-level signal, not per-user drift.

### 8.3 The drift check (most reliable the contract supports)

Per key, maintained by the poller:

- **Accumulated usage** `U` (`tokens_used_observed`): poll logs every cycle (§8.4). Let `Δtotal = total_now − logs_total_seen`. Sum `cost_tokens` over the newest `min(Δtotal, 30)` rows and add to `U`; update `logs_total_seen = total_now`. If `Δtotal > 30`, the excess rows are **unobservable**: mark the snapshot (and that day's rollup) `partial`, and add the *unobserved gap* `g += Δtotal − 30` to a per-key counter `logs_gap_rows`. Dedup guard: if `Δtotal = 0` but the newest row's composite hash (created_at+model+cost_tokens+latency_ms) differs from `logs_newest_hash`, treat as 1 new row (protects against total-count lag). This makes `U` a **lower bound** on true usage, with a known gap indicator.
- **Issued limit** `L` = `token_limit_issued` (our bookkeeping of confirmed ops).
- **Observed remaining** `B` = balance (§8.2: an upper bound on true remaining).

Checks, in order:

1. **Over-issuance (money-critical, equality-grade):** `U + B > L + ε` ⇒ the provider thinks the key has more total value than we ever issued (lost top-up double-applied, manual portal edit, or our `confirmed` bookkeeping is wrong). This direction is dangerous (user can spend unpurchased tokens) and the inequality is sound under our interpretations: `U` understates usage and `B` overstates remaining, so `U + B` overstates the total — a breach means *even the most provider-generous reading* exceeds what we sold plus epsilon. Flag immediately.
2. **Under-issuance:** `B < L − U − ε − (gap allowance)` where gap allowance = `g × p95 cost_tokens per request` for the key (from its own logs; default 50k tokens/request when no history). The user has less than they bought — could be a lost top-up, an unrecorded portal reduction, or simply unobserved usage (the gap term exists precisely so partial polls don't cry wolf). Flag only on **two consecutive** breaching polls (hysteresis), because every input here is a bound, not a fact.
3. **Epsilon:** `ε = max(100_000 tokens, 1% of L)`. Rationale: in-flight requests settle after the poll; cached-token accounting quirks and Fast-coefficient timing can shift a request's billed figure slightly; 100k tokens ≈ 0.5% of the smallest pack (20M) and 1% scales with the 400M pack. Anything inside ε is noise by definition and is *logged* (snapshot row) but never flagged.

Flagging: insert `risk_flags { kind: 'provider_drift', created_by: 'system:reconciler', note: <figures: L, U, B, check, gap> }` — **deduped**: skip if an open `provider_drift` flag already exists for the user (update nothing; the figures live in the snapshot rows). Auto-resolve is *not* performed: a human resolves the flag from the dossier (existing resolve route), after applying any corrective intent (`reduce` for over-issuance — idempotent, §3.4; a fresh `topup` with `source='reconcile_fix'` for proven under-issuance). The flag + snapshots + intents together are the analyst-visible trail (§7.4).

### 8.4 Schedule and triggers

- **Periodic:** in the same worker process (§3.3): every **15 minutes**, a batch of up to 50 keys, least-recently-reconciled first, jittered start. Each key poll = 1 balance call + 1 logs call with its own key. At 1k active keys that's a full sweep in ~5 h — too slow for the usage tracker; so polling is **activity-tiered**: keys with a proxy request in the last hour (the §6.2 throttled touch timestamp) or with a pending/attention intent poll every cycle; idle keys poll every 4th cycle. (The usage WS, §0 non-goals, is the documented future fix for high-frequency keys.)
- **Manual:** admin per-user refresh (§7.2) runs the same check for one key immediately; a global "run now" (owner-only, `POST /admin-api/provider/reconcile`) enqueues a sweep.
- **Event-driven:** after any intent confirms for a key, schedule an out-of-cycle poll 60 s later (verifies the op landed in observable state; a create verifies `meta` at birth instead).

### 8.5 Pool health + reconciliation unavailability

- Each sweep also reads the balance **with the primary key** (contract allows balance reads with any owned key; the primary's figure reflects the account pool combined with its own unlimited/primary allowance — interpreted only as a pool gauge). If the pool gauge falls below `sum(active keys' (L − U)) × 0.2` headroom or below an absolute floor set in settings, raise an **ops alert**: `admin_audit` action `provider_pool_low` + analyst-context field (§7.4). (risk_flags is per-user by schema, so pool alerts deliberately use audit + analyst, not a fake user flag.)
- If the provider is unreachable for a whole sweep: the run is recorded (a snapshot row per attempted key is *not* written; instead `last_reconciled_at` stays and the worker logs `reconcile_sweep_failed`), no flags are raised on stale data, and the next sweep retries with the normal cadence. Drift decisions are never made from data older than the poll that produced it.

---

## 9. Migration path for existing v1 users (lazy conversion)

Population: users whose balance lives in ledger lots under the shared-key system, including users who have never bought (balance 0 — nothing to convert; their first Phase-2 purchase takes the §3 path).

### 9.1 Conversion semantics

- **Trigger points (whichever first):** (a) the user's next successful `/api/account-status` (login/launch revalidation) after the flag reaches them (§11 stages), or (b) their next claim approval (the approval's intent logic checks conversion first, §9.3). No batch job converts everyone up front — lazy conversion bounds provider-call volume and blast radius.
- **Amount:** computed inside a new SECURITY DEFINER RPC `public.begin_provider_conversion(p_user_id)` (migration 00007), which under the user-row lock (the same serialization discipline as the money RPCs):
  1. Returns early with the existing state if `user_provider_keys.converted_at` is set (idempotent).
  2. Computes `amount = spendable_tokens(user)` — unexpired lots minus **active holds**. Holds matter: a mid-flight v1 request must not be double-counted. If active holds exist, the RPC returns `deferred_holds_active` and conversion retries on the next trigger (holds settle in seconds; the flag rollout in §11 also drains: per-user routing flips only via conversion, and a user with a stuck hold simply stays on the shared path until it settles — the two paths coexist per-user during rollout, §11).
  3. Inserts the ledger marker: `kind='convert'`, `delta_tokens=0`, `amount_tokens=amount`, `idempotency_key='convert:v1:<userId>'`, `ref_type='provider_key'`, meta `{ phase: 2 }`. The unique ledger idempotency index makes a racing second call a no-op.
  4. Sets `converted_at=now()`, `converted_tokens=amount` on the key shell row (creating it if needed).
  Then the API layer inserts the `convert` intent (`idempotency_key='conversion:<userId>'`, `amount_tokens=amount`) post-commit, with the §3.1 sweeper anti-joining on `converted_at IS NOT NULL AND no convert intent` as the guarantee.
- **Exactly once, no loss, no double-credit:** the amount is frozen by steps 2–4 in one transaction; the intent carries that frozen number; the worker executes create-with-limit=amount or top-up-additional=amount; a second trigger hits step 1. If the provider op lands ambiguously, §3.4's create/topup rules apply unchanged (conversion inherits the safest machinery, it doesn't get its own).
- **Zero amount:** `converted_at` is still set (marker + intent skipped — a 0-token key is pointless; the provider rejects non-positive limits anyway). The user's first purchase then creates the key via §3.
- **What conversion does *not* do:** it does not zero the lots or rewrite ledger history. The ledger remains the purchase record (binding constraint). In per-user mode the lots are simply no longer consulted for spendability (§7.1) — `account_status`'s lot view is replaced, not the data. Per-lot **expiry is not carried to the provider** (provider limits have no expiry concept): converted amounts become non-expiring allowance. At launch this is a non-issue (all default packs have `validityDays = null`), and §13 A7 flags it as an owner-visible product decision for any future expiring pack: such a pack must not be sold in per-user mode until a provider-side expiry story exists.
- **Refunds of pre-conversion purchases** after conversion: `refund_order` still debits the ledger (record), and the `reduce` intent (§4.5) clamps at the provider — the two records stay consistent through the same mirror as post-conversion refunds.

### 9.2 Host/panel behaviour during conversion

`account-status` returns `providerKey.status='converting'` while the intent is live; the GUI treats it like `pending_create` (no banner; subscription turns for that user still route shared until conversion confirms — the per-user routing decision in §11 is "converted + key active", evaluated server-side per request, so the transition is seamless and needs no client release).

### 9.3 Interaction with a purchase during conversion

Claim approval for a not-yet-converted user inserts intents in order: the conversion intent (older balance) first, then the claim's create/topup — the worker's per-user FIFO (§3.3) preserves the order, and coalescing (§3.3) may fold them pre-dispatch. The end state is identical either way: `L = converted + granted`.


---

## 10. Failure-mode table

| # | Failure | System behaviour | User sees | Admin sees |
|---|---|---|---|---|
| 1 | Timeout after **create** dispatched | Intent → `needs_attention`; never auto-retried (§3.4). Key, if created, is an unspendable orphan identifiable by name in the portal. | Purchase safe; app shows key "being finalised"; subscription turns stay on prior path until resolved. | Attention banner + intent with attempt log; **Create replacement** action (§3.5); orphan-cleanup runbook. |
| 2 | Timeout after **top-up** dispatched | Intent → `needs_attention` with pre-op snapshots; no auto-retry (double-add risk). | Balance may or may not yet reflect the pack; purchase record (panel) already shows approved. | Resolution view with balance evidence; Mark applied / Retry once / Escalate (§3.5). |
| 3 | Provider down at **approval** time | Approval commits fully (ledger + order). Intent stays `pending`; worker backs off; sweeper guarantees the intent exists. | Purchase approved; key provisioning "queued". Nothing lost. | Order approved as normal; intents queue depth visible; provisioning completes when provider returns. |
| 4 | Provider `402` during **runtime** | Relay maps to `insufficient_credit` (§6.4). Distinction allowance-vs-pool is *not* surfaced to the user (same remedy: wait/buy; pool case is ops' problem, §8.5). | Existing credit-exhausted banner. | Pool alert if systemic (§8.5); per-user drift check on next sweep. |
| 5 | Provider `403` during **issuance** | Control-plane auth failure: intent `failed`, issuance circuit-breaker opens, audit alarm (§3.4). | Provisioning delayed; purchases unaffected. | `provider_control_plane_auth_failed` audit + breaker state; fix is config (primary key / reseller role), then manual re-enable. |
| 6 | Provider `403` during **runtime** (delegated key) | Relay → `502 provider_forbidden` + alarm (§6.4). | Generic turn error. | Alarm in logs/audit; investigate reseller access. |
| 7 | User **suspended with issuance pending** | Worker cancels the pending create/topup; freeze intent (if a key exists) jumps the queue. On reactivation, unissued approved total is recomputed and re-intented (§4.2). | Account disabled as today. | Intent history shows cancelled + freeze; reactivation restores allowance automatically. |
| 8 | Provider `409` during issuance | Terminal for that intent (`failed` + provider code recorded). Unreachable in normal delegated-key flows; treated as a bug signal. | Provisioning delayed. | Intent detail with code; engineering follow-up. |
| 9 | Provider `429` (control plane or runtime) | Issuance: intent → `pending` with `Retry-After`/backoff (safe). Runtime: passed through. | Nothing (issuance) / engine retry (runtime). | Queue depth + backoff visible in intent list. |
| 10 | Provider `500/503` during **issuance reads** (balance/logs) | Safe-retry with backoff; reconciliation sweep marks run failed, raises **no** flags on stale data (§8.5). | Balance may show stale flag. | Sweep failure log; drift states unchanged. |
| 11 | **Reconciliation unavailable** for an extended period | Usage rollups and drift flags pause; issuance and runtime are unaffected (they don't depend on reconciliation). Balance cache ages → panels show "unavailable" after 24 h rather than a stale number (§7.1). | Aggregates stop advancing; per-request recent list still live (direct logs call can also fail → empty state with retry). | `reconcile_sweep_failed` logs; analyst context shows last successful sweep time. |
| 12 | Primary account **pool exhausted** | All keys 402 at runtime (§8.2/§8.5). No per-user action can fix it. | Credit-exhausted banner (unavoidable conflation — accepted, §10 note below). | Pool-low alert fires *before* exhaustion (§8.5 headroom rule); remedy: fund the primary account. |
| 13 | Encryption key env missing/wrong at startup | Per-user issuance + relay paths refuse to run (fail closed); shared mode unaffected; intents accumulate safely as `pending`. | Shared-mode users unaffected; per-user users see provisioning pending. | Startup log `cvc_key_encryption_key_invalid` (no value) + worker state in admin. |
| 14 | Decrypt failure on one row (corrupt ciphertext / wrong key after rotation mishap) | That user's relay path returns `503 provider_key_not_ready`; intent `needs_attention` raised; **never** auto-recreates the key (would double-issue allowance). | "Key being finalised" state. | Attention item with row id; remedy is a supervised replacement create after verifying provider-side state via portal/balance evidence. |
| 15 | Host holds a **stale key** after replacement (orphan incident §3.4) | Relay fingerprint lookup fails → `401`-shaped auth error → host re-fetches credential (§5.2c), stores the new key, retries the turn once. | At most one failed turn, self-healing. | Nothing (normal path), unless re-fetch also fails. |
| 16 | Flag flipped to `shared` mid-rollout (rollback) | §11 procedure, not a bare flip, once any per-user consumption exists. | Per-user users return to ledger balance (adjusted per §11). | Rollback checklist + audit entries per user. |

Note on row 12 vs row 4: the provider's 402 does not distinguish "your allowance is gone" from "the house is out of funds", and the relay must not invent a distinction it cannot verify. The mitigation is operational (pool headroom alerting), and it is called out here rather than papered over in UX copy.

---

## 11. Rollout, feature flag, rollback

### 11.1 The flag

Server-side only, stored as the `subscription_routing` settings document (§2.5), read through the existing `getSetting` machinery, written by an owner-only admin endpoint (`PUT /admin-api/settings/subscription-routing`, audit-logged):

```json
{ "mode": "shared" | "per_user",
  "allowlist": ["<user uuid>", …] }        // consulted only in stage 1–2
```

Effective mode for a user = `per_user` iff `mode='per_user'` globally, or the user is in `allowlist` during staged rollout; **and** (for the *proxy routing* decision) the user has a confirmed conversion + active key — otherwise that user's traffic stays shared (§9.2). Issuance intents are created for a user iff their effective mode is `per_user`. No client-side flag exists; the host/panels learn the mode from `account-status` (§7.1).

### 11.2 Stages

0. **Deploy dormant.** Migration 00007 + reseller client + worker + relay branch ship with `mode='shared'`. Worker runs only the sweeper in no-op verification mode. Nothing user-visible changes.
1. **QA allowlist.** One internal user: full lifecycle (§12 live-smoke) end-to-end on the real provider with the smallest pack.
2. **New purchases only.** `mode='per_user'` with the understanding that conversion (§9) pulls existing *buyers* over lazily at their next login/purchase; non-buyers convert at next login too (zero-amount marker). BYOK untouched throughout.
3. **General.** Allowlist removed. Shared path remains compiled in for rollback.
4. **Cleanup (separate decision, not Phase 2):** remove Hold/Commit path, drop `holds` writes, retire `UPSTREAM_API_KEY` — only after a full reconciliation-clean period (§8) at stage 3.

### 11.3 Rollback

- **Before any per-user consumption** (stages 0–1, or a user who never ran a turn): flipping `mode='shared'` is a complete rollback. Ledger balances were never debited by provider usage because there was none.
- **After per-user consumption exists:** a bare flip would resurrect already-spent ledger lots (provider usage never wrote `consume` rows). The rollback *procedure* per affected user is therefore: (1) stop new issuance (flag off for new intents); (2) read the key's accumulated observed usage `U` + a final logs poll; (3) post a ledger `adjust` debit of `min(U, ledger balance)` with note `phase2-rollback` and meta `{ observedUsage: U, gap: <partial?> }` — if the key's data is `partial`, the owner decides the debit figure case-by-case from the dossier (money rule: no automated guess on partial data); (4) freeze the provider key (leave it frozen, do not delete — re-rollforward stays possible); (5) flip routing. Steps are scripted as an admin action (`POST /admin-api/provider/rollback-user`, owner-only, audited), not hand-run SQL.
- Rollforward after rollback: conversion marker prevents re-conversion; a `convert`-delta intent tops the key up by (ledger-approved total − `token_limit_issued`) so already-frozen allowance resumes exactly where it left off.

---

## 12. Test plan

### 12.1 Unit — reseller client against a mock provider

Build `server/test/mock-cvc.mjs`: an HTTP mock implementing the contract faithfully — create (201 + one-time plaintext + meta), edit (additive top-up, absolute reduction rules incl. `token_limit ≥ tokens_used`, freeze/unfreeze, delete, 409 cases), logs (30-row cap, `total`), balance, the error envelope, and **fault injection**: (a) *ambiguous timeout* — the mock **commits** the mutation, then hangs past the client timeout; (b) *lost create* — commits the key, drops the response; (c) 429 with `Retry-After`; (d) 403 for non-primary credentials.

Client/worker unit tests (node:test, matching the existing suite's style):

- Encryption round-trip; AAD tamper (row-swap) fails; wrong env key fails; `v1:` format stable.
- Create happy path persists ciphertext + fingerprint + `token_limit_issued`; plaintext never appears in DB rows, logs, or attempt entries (grep-the-world assertion over captured log output).
- Ambiguous create → `needs_attention`, **zero** retries dispatched (mock counts calls); replacement flow issues exactly one new key.
- Ambiguous top-up → `needs_attention`; mock's limit proves no double-add; `mark_applied` and `retry_once` resolutions each converge `token_limit_issued` correctly.
- Absolute reduce retried after an ambiguous failure is safe (mock limit ends at target exactly once).
- Primary guard: any attempt to target the primary key (by fingerprint) throws pre-dispatch (mock receives nothing).
- Freeze/unfreeze idempotent re-dispatch; delete-then-delete → second is `confirmed` via 404 rule.
- Worker: per-user FIFO ordering; suspended-user cancellation; coalescing only pre-dispatch; lease reclaim of a crashed `in_flight` mutation routes to `needs_attention`, never re-execution.
- Sweeper: approved order with its inline intent insert forcibly skipped still gets an intent within one sweep; duplicate sweep runs create no duplicates (unique keys).

### 12.2 Integration — embedded test stack

Extend `server/test/helpers.mjs#startStack` with the mock CVC server beside the fake upstream (the stack already runs real Postgres + GoTrue + migrations). New suite `server/test/reseller.test.mjs`:

- Approval → issuance → key active; balance endpoints serve provider figures; claim response carries `issuance.state`.
- Second purchase → top-up (same key row, `token_limit_issued` sums); partial-amount approval credits proportionally at the provider too.
- Suspend → sessions revoked immediately (existing behaviour) + freeze confirmed; runtime call with the frozen key rejected at provider; reactivate → unfreeze → runtime works.
- Refund → ledger debit + `reduce` intent → provider limit lowered by exactly `tokensRemoved`.
- Runtime through the relay: buffered + streaming completions succeed with the user's key (mock asserts the Authorization it received is the delegated key, **not** the session token and never the primary); provider 402 → relay `insufficient_credit`; admin-disabled model → 403 before any provider call (mock call count unchanged).
- Conversion: seed a v1 user with lots + balance (existing `grant` helper), trigger via account-status, assert exactly-once under concurrent duplicate triggers (two parallel account-status calls + a purchase approval racing), amount equals spendable, ledger marker present once, second trigger no-ops. Conversion with an in-flight hold defers, then completes after the hold settles.
- Provider-down-at-approval: mock CVC stopped → approval still 200 + ledger correct; mock started → intent drains to `confirmed` without admin action.
- Feature flag: shared mode creates **no** intents and routes through Hold/Commit (existing metering suite must pass untouched).

### 12.3 Host tests (`host/test/`)

- `CredentialStore`: `subscriptionKey` persists/clears with the record; survives reload; absent after logout and after session-clear; never written to `auth.json`/`config.json` (filesystem assertions, extending `auth.test.mjs` patterns; the existing mock Ronin server in `host/test/mock-ronin.mjs` gains the credential endpoint + `routingMode`).
- `buildSubscriptionAttempt`: per-user mode uses the delegated key; shared mode uses the session token (regression lock on §1.3's seam); missing key triggers one credential fetch before failing.
- `classifyProxyError`: `account_suspended` → locked kind (the §6.4 host change); 402 still → `insufficient_credit`.
- Stale-key self-heal (§10 row 15): relay 401 → one credential re-fetch → retry succeeds.

### 12.4 Panel tests

- User panel (existing live/mock API test setup): recent-usage list renders exactly the 30-row window + total + window note; summary endpoint drives dashboard in per-user mode; `deriveUsage` path unchanged in shared mode; purchase row shows issuance states incl. the "purchase is safe" attention copy.
- Admin panel: key section renders DB state + history; freeze/unfreeze buttons respect `risk_manage` (hidden/disabled without the cap) and CSRF; `needs_attention` resolution is owner-only in UI *and* API; drift flag appears in the dossier count and resolves through the existing route.

### 12.5 Live-smoke checklist (one QA key lifecycle, real provider)

Run once at rollout stage 1, with a dedicated QA user and the smallest pack; verify in the provider portal where noted:

1. Approve QA claim → key created; portal shows the key with name `ronin-<uuid8>-<intentId>` and the portal-set `sk-ronin` prefix (observed, never parsed); limit = pack tokens.
2. `GET /v1/balance` with the QA key ≈ pack tokens; app balance matches after cache TTL.
3. One subscription chat turn through the relay succeeds; provider logs show the request with plausible `cost_tokens`; accumulated usage tracker picks it up on the next poll.
4. Second (admin manual) top-up of a small amount → limit increases additively; no new key in the portal.
5. Suspend QA user → key frozen (portal + a runtime call fails); reactivate → unfrozen → runtime succeeds.
6. Force a drift figure by a portal-side manual limit tweak → next sweep raises exactly one `provider_drift` flag; resolve it from the dossier; corrective `reduce` converges the limit.
7. Close QA account → key deleted in portal; our row shows `deleted` with ciphertext wiped.
8. Throughout: grep server logs + admin audit for any key material or primary-key value — must be zero hits; confirm no flow ever targeted the primary key (portal activity + guard audit empty).

---

## 13. Ambiguities resolved & contradictions found

### A. Contract ambiguities — safer interpretation chosen (money rule)

- **A1. `/v1/balance` semantics** ("combined" customer balance + key allowance): treated as an **upper bound** on the key's remaining allowance; display + inequality checks only, never a money input (§8.2).
- **A2. No get-key/list-keys endpoint:** provider-side `tokens_used` is unobservable directly; reconciliation is built from bounds (accumulated logs = lower bound on usage) rather than pretending otherwise (§8.1). The OpenRouter blueprint's hash-addressable per-key reads do **not** exist here; the provider contract wins.
- **A3. Logs have no request id and cap at 30:** dedup is by `total` delta + newest-row hash; gaps are tracked and widen the drift tolerance instead of being silently absorbed (§8.3).
- **A4. Edit-response bodies unspecified** (except delete): the worker treats any 2xx edit as applied-as-sent and verifies via the next reconciliation poll rather than expecting confirmation figures (§8.4 event-driven poll).
- **A5. `allowed_models`:** omitted (= full catalog, dynamically) instead of an explicit 44-model list that would freeze the catalog at issuance (§3.2). This satisfies the mission's "full account catalog" semantically; flagged here because it deviates from the literal wording.
- **A6. Catalog/coefficient drift:** our displayed coefficients come from `docs/model-catalog.json`; the provider bills by *its* live coefficients (incl. per-key Claude overrides and Fast multipliers). Phase 2 accepts provider billing as truth; a catalog-sync check (compare `GET /v1/models` multipliers against the catalog during the sweep, alert on divergence) is specified as part of the reconciler's run, because silent divergence misprices packs. No user-facing figure depends on our table being right — but pack *economics* do, hence the alert rather than silence.
- **A7. Lot expiry has no provider analogue:** converted/purchased allowance does not expire (§9.1). Non-issue for current packs (no validity), flagged as a product decision before any expiring pack is sold in per-user mode.
- **A8. In-flight overshoot:** the provider charges on completion, so a request admitted just under the cap can settle slightly over it (the OpenRouter report's caveat applies structurally here too). Epsilon (§8.3) absorbs this; we never promise users an exact-token cut-off.

### B. Blueprint vs contract (provider wins)

- OpenRouter's cumulative-ceiling PATCH trap does not apply: `additional_tokens` is additive (contract §4 of the reseller doc). Our ledger therefore tracks `token_limit_issued` for *verification*, not because top-ups need absolute arithmetic — reductions are the only absolute op.
- OpenRouter keys are hash-addressable with rich usage reads; CheapVibeCode keys are addressed **by the secret itself** in edits and are usage-readable only via their own logs/balance. This is why the encrypted store + fingerprint design (§2) carries more weight here than in the blueprint.

### C. Contradictions between the mission/brief and the current codebase (flagged, not fixed)

- **C1. Migration number.** The brief says the new migration is logical `00006`; the repo already has `20261022000006_handoff.sql`. This design targets **00007** (`20261023000007_provider_keys.sql`). Shipping a second "00006" would corrupt the chain.
- **C2. Account closure does not exist.** The brief says closure deletes the key "(admin-triggered, existing confirmation patterns)". There is no closure/deletion action in `server/src/admin/app.js` — only suspend/reactivate (`toggle-active`), device revoke, and refunds. §4.4 therefore specifies a *new* flow assembled from existing patterns (owner-only + typed confirmation + audit, borrowed from refund/claim flows). It is new surface, and should be reviewed as such.
- **C3. "Approval already credits the user" vs "credit = provider allowance".** `approve_claim` grants ledger credit + lots today, and the binding constraint says the ledger stays the purchase record. Resolution (§3.1): the RPC grant stays as the *record*; spendability moves to the provider. But this means **lots become vestigial in per-user mode** while `account_status`/spendable logic still reads them — every balance surface must branch on routing mode (§7.1), or users will see ledger balances the proxy no longer honours (and vice versa after rollback, §11.3). This dual-bookkeeping is the design's biggest ongoing hazard and the reason the flag + rollback procedure are specified so defensively.
- **C4. Host credential seam.** The brief's "host obtains its key over the existing session channel" collides with the current design where the session token *is* the subscription credential (§1.3). §5 + §6.2 resolve it with explicit delivery + dual-auth proxy. Anyone implementing only the server half will break the host; the host changes (§5.3, §6.4 classifier) are **required**, not optional polish.
- **C5. GUI/host error mapping gap.** `classifyProxyError` maps any 403 to `model_disabled` today. A provider/local frozen-key 403 would mislabel as a model problem. §6.4 specifies the `account_suspended` code + one-line classifier change; without it, suspended users see the wrong banner.
- **C6. User-panel usage derivation.** Dashboard aggregates derive from ledger `consume` rows (`web/user-panel/src/lib/api/usage.ts`), which per-user mode stops producing. §7.3 replaces the source; unaddressed, the dashboard would silently flatline at conversion — the worst kind of regression because nothing errors.
- **C7. Refunds/charges are ledger-only today.** Without §4.5's mirror intents, every refund would surface as false reconciliation drift within a day of rollout. The mission text mentions refunds nowhere; the design includes them because the codebase's money flows require it.
- **C8. `account_status` RPC is lot-based.** The daily-revalidation payload (lots, spendable) is computed from lots inside Postgres. Per-user mode needs the §7.1 field substitution at the API layer; the RPC itself is left untouched (shared mode + rollback depend on it), which means the API layer — not the RPC — owns the mode branch. Noted so implementers don't "fix" the RPC and break rollback.

---

## 14. Ops appendix (runbook sketches)

- **Orphan key cleanup:** provider portal → find key by name `ronin-<uuid8>-<intentId>` (intent id from the attention item) → confirm zero usage → delete in portal → resolve the intent as `superseded` with the replacement intent id in the resolve note.
- **Pool top-up decision:** alert threshold §8.5; the pool figure is the primary-key balance read; funding the primary account is an owner action outside the system (no in-product flow exists or is designed).
- **Issuance breaker reset:** after fixing a 403-class config problem, owner re-enables issuance from the admin provider section; `failed` intents from the incident are re-queued individually (never bulk — each was terminal for a recorded reason).
- **Secret rotation:** `CVC_PRIMARY_API_KEY` rotation is a provider-portal + env change; delegated keys are unaffected (they belong to the account, not to the primary key — but per the contract's promotion rule, **never delete/freeze the old primary until the new primary is confirmed in place**, and the §3.6 guard must be re-pointed at the new value via env before resuming edits). `CVC_KEY_ENCRYPTION_KEY` rotation follows the §2.3 version-prefix path and is a planned maintenance, not an incident response.

---

*End of design. Implementation is a separate, later assignment; this branch contains no code changes.*
