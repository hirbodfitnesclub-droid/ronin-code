# Ronin Code — Architecture

How the codebase is organized, where each rule lives, and how to verify
changes. Everything here describes the code as it stands at v1.0.0.

## System overview

```
┌────────────┐   HTTP + SSE (token-guarded, loopback)   ┌──────────────┐
│  GUI (gui/)│ ───────────────────────────────────────▶ │ Host (host/) │
│ React+Vite │ ◀─────────────────────────────────────── │ Node, stdlib │
└────────────┘        /api/*, /preview/, static         └──────┬───────┘
                                                               │ embedded SDK
                                                               ▼
                                                        Agent engine
                                                        (internal library)

┌────────────┐   HTTPS (subscription mode only)   ┌────────────────────┐
│  App / GUI │ ─────────────────────────────────▶ │ Server (server/)   │
└────────────┘   OTP login, balance, claims,      │ accounts + billing │
                 metered chat completions         │ + metering proxy   │
                                                  └─────────┬──────────┘
                                                            │ upstream keys
                                                            │ NEVER leave here
                                                            ▼
                                                      LLM providers
```

- **Host** is the local desktop service: it owns the user's project
  files, BYOK keys (stored only on this device), the agent engine, and
  every safety/cost rule for local turns. It never phones home.
- **Server** is the subscription backend (accounts, credit ledger,
  payments, metering). It is *not* involved in BYOK turns.
- **Desktop** (`desktop/`, Tauri v2) packages the same GUI + host for
  Windows; only the shell differs.

## Host module map (`host/src/`, plain ESM, stdlib only)

| Module | Lines | Responsibility |
|---|---|---|
| `server.js` | 9 | Entry point only: `startHost()`. |
| `http-server.js` | 113 | HTTP server, static GUI, `/preview/`, `/ronin-config.js` bootstrap. |
| `routes.js` | 445 | The whole `/api/*` dispatch (thin handlers → modules below). |
| `http.js` | 79 | `sendJson`, body reading, token/origin guards for the API. |
| `sse.js` | 27 | SSE client registry, event broadcast, hello frame. |
| `config.js` | 155 | `~/.ronin-code` config + auth storage, provider/model selection, project open state. |
| `paths.js` | 40 | All filesystem paths + `VERSION`. |
| `engine.js` | 338 | Engine session lifecycle, event→activity mapping, failover attempt loop (see `host/ENGINE.md`). |
| `turns.js` | 193 | Turn orchestration: preview/live dispatch, plan-mode gate, plan revisions, idea maturation. |
| `guard.js` | 151 | **Trust layer**: approval gate for bash/outside writes, `.env` hard block, secret redaction hooks. |
| `router.js` | 143 | **Router brain**: multi-key LRU rotation, cooldowns, failover classification, RTK output compression. |
| `cost.js` | 80 | **Pricing**: per-model price table + multipliers, cost math, budget cap. |
| `usage.js` | 79 | Per-key request counters, session cost accumulation. |
| `snapshots.js` | 128 | Snapshot manifests, Undo, named checkpoints. |
| `diff.js` | 53 | LCS-based unified diff (pure). |
| `publish.js` | 82 | Zip export + static `dist/` build. |
| `starters.js` | 46 | Starter project scaffolding. |
| `util.js` | 29 | `cleanError` (redacting error sanitizer), misc. |
| `log.js` | 20 | Structured JSON-line logger (see Quality charter). |

Module style: one responsibility per file, cross-module state only via
explicit exports (`config` is a single mutable object; turn/plan state
via getters/setters in `turns.js`). No file exceeds ~450 lines.

## Frontend architecture (`gui/src/`)

**Standard adopted: pragmatic Feature-Sliced Design (FSD-lite)** —
layers `app → features → shared`, dependencies point downward only, each
feature exposes a public API through its `index.ts`.

```
src/
  App.tsx            composition root only (178 lines): wires hooks + features
  main.tsx           bootstrap
  features/
    chat/            ChatPanel, Timeline, Composer, EmptyState, useChat (stream state machine), types
    shell/           Header (brand, project actions, Auto/Plan pills, cost chip)
    preview/         PreviewPanel (iframe + branded empty state)
    settings/        SettingsModal, RouterSection (multi-key/failover editor)
    onboarding/      Onboarding overlay
    idea/            IdeaPanel (idea → matured product brief)
    plan/            PlanCard
    approvals/       ApprovalCard
    changes/         ChangesCard (+ diff view)
    publish/         PublishPanel
    checkpoints/     CheckpointsPanel
    starters/        StartersModal
  components/ui/     Logo, RichText, ActivityVisual, ErrorBoundary
  hooks/             useSession (status, providers, language, cost, project actions)
  lib/
    api.ts           the ONLY module that talks to the host — fully typed request/response contracts
    format.ts        interpolate / number / USD formatting (pure)
    diff.ts          unified-diff line classification for rendering (pure)
    errors.ts        host error-code → i18n key mapping (pure)
    i18n/            en.ts + fa.ts dictionaries (key-parity tested), context/provider in index.tsx
  styles/            layered global CSS — see below
  test/ (gui/test/)  unit tests for the pure lib modules
```

**Decisions (researched 2025/2026 practice, adapted to this product):**

- **No state library.** State lives in hooks (`useSession`, `useChat`)
  and one context (language). The app is single-window, local-first,
  with exactly one consumer tree — Zustand/Redux/TanStack would be
  ceremony without payoff. Revisit if a second window/consumer appears.
- **Layered global CSS, deliberately not CSS Modules.** Class names are
  the DOM contract for QA fixtures and screenshot comparison; hashing
  them would endanger the zero-visual-change bar. Partials under
  `styles/` are imported by `styles/index.css` in a fixed cascade order
  (tokens → base → layout → shell → features → reduced-motion → fonts →
  RTL → feature sections). `tokens.css` holds every design token (CSS
  variables: colors, spacing, typography) — the single source for the
  visual system.
- **Pure logic in `lib/`**, unit-tested with Node's type stripping
  (`node --experimental-strip-types --test`) — no test-framework
  dependency for a handful of pure modules. Same approach as the host's
  unit tests (`node --test`).
- **Documented FSD deviation:** the chat `Timeline` (host widget)
  imports the leaf cards from `plan/`, `approvals/`, `changes/`. Cards
  never import chat back; the cycle is one-directional and intentional.

Research sources consulted for this standard: Feature-Sliced Design
official docs + practical guides (feature-sliced.design), React folder
structure / hooks architecture write-ups (dev.to, 2025), CSS layering
and organization (OpenReplay), CSS Modules vs Tailwind vs CSS-in-JS
comparisons, ESLint 9 flat-config + React + TS setups, state-management
comparison surveys (2025).

## Server module map (`server/src/`, plain ESM, stdlib + `node:sqlite`)

Accounts and billing for subscription mode. Highlights: `auth.js`
(OTP + refresh rotation with reuse detection), `ledger.js` (append-only
credit ledger, FIFO lots, expiry), `orders.js` (card-to-card claims,
atomic idempotent approval), `proxy.js` (metering proxy with
hold/commit reservations — upstream keys exist only here), `admin/`
(standalone admin app on its own listener with its own OTP login and
`admin_audit` trail), `sms/` (Kavenegar provider; console provider is
dev-only), `log.js` (structured logger).

## Where each rule lives

| Rule | Owner |
|---|---|
| Approvals for commands / outside writes, Auto mode, `.env` block, redaction | `host/src/guard.js` (+ engine extension wiring in `engine.js`) |
| Pricing, per-model multipliers, budget cap | `host/src/cost.js` (client-side estimate) and the server price table (authoritative for subscription billing) |
| Key rotation, cooldowns, failover order, RTK compression | `host/src/router.js` |
| Credit ledger integrity (append-only, idempotent approvals, hold/commit) | `server/src/ledger.js`, `server/src/orders.js`, `server/src/proxy.js` |
| Session cost shown in the header | host `usage.js` → `/api/status` → GUI `useSession` |
| Language strings (EN/FA) | `gui/src/lib/i18n/{en,fa}.ts` — the host never localizes; it returns stable error `code`s that the GUI maps to strings |
| Upstream provider keys | server vault only (subscription) / user's device only (BYOK). Never in the GUI, never in logs. |

## Data flow (one live turn)

1. GUI `useChat.send()` → `POST /api/turn` (host token header).
2. Host `turns.runTurn` logs `turn_started` (with a turn id), snapshots
   the project (`snapshots.js`), then `engine.js` runs the session.
3. Engine tool calls pass the `guard.js` extension: bash/outside writes
   pause for an approval card (SSE `approval_request` → GUI →
   `POST /api/approval`), `.env` access is hard-blocked, outputs are
   redacted and RTK-compressed (`router.js`).
4. Provider errors classified retryable by `router.js` fail over to the
   next key/provider; usage lands in `usage.js`/`cost.js`; SSE
   `turn_usage` updates the header cost chip.
5. On `turn_done`, the GUI appends a Changes card (diff via
   `host/src/diff.js` through `GET /api/diff`) and refreshes the preview
   iframe. Undo restores the snapshot.

## Quality charter

- **ErrorBoundary** (`gui/src/components/ui/ErrorBoundary.tsx`) wraps
  the app shell: a render error shows a calm bilingual (FA/EN) fallback
  with a reload action — never a white screen — and reports the error
  best-effort to `POST /api/client-error` (host logs it as a capped,
  structured `client_error` record).
- **Structured logging**: one dependency-free JSON-line logger per side
  (`host/src/log.js`, `server/src/log.js`) with levels and request/turn
  ids. Hard rule: **never log keys, tokens, OTPs, passwords, or prompt
  content — metadata only.** Sole documented exception: the dev-only
  console SMS provider prints OTPs to the operator's own console so
  local development can read them; production uses Kavenegar.
- **Release discipline**: semver everywhere (root/gui/host/server
  `package.json`, `desktop/src-tauri/tauri.conf.json`, host `VERSION`)
  and a Keep-a-Changelog `CHANGELOG.md`.
- **Bundle budget**: CI fails if the gzipped GUI JS exceeds **300 KB**
  (v1.0.0 actual: ~64 KB) — a guardrail for the future, not a target.
- **Lint/format**: ESLint 9 flat config + Prettier for the GUI
  (TypeScript/JSON). CSS partials are intentionally outside Prettier —
  their compact hand-tuned layout is preserved verbatim.
- **Behavior-preservation discipline for refactors**: the E2E suite and
  screenshot set are the contract; both must pass unchanged after every
  structural commit.

## Running the test suites

From the repo root:

| Suite | Command | Covers |
|---|---|---|
| Host E2E | `node host/test/e2e.mjs` | Full host against a mock provider: trust layer, router, plan, ideas, publish (29 checks) |
| Host unit | `npm --prefix host run test:unit` | Pure logic: diff, RTK, pricing, redaction, key rotation, zip (24 tests) |
| GUI unit | `npm --prefix gui test` | Pure helpers: formatting, diff rendering, i18n key/placeholder parity (10 tests) |
| Server | `npm --prefix server test` | Auth/OTP, ledger, claims, metering proxy (16 tests) |
| GUI build | `npm run build` | `tsc -b` (strict) + Vite production build |
| GUI lint | `npm run lint` | ESLint over `gui/src` |
| Typecheck | `npm run typecheck` | `tsc -b` without emitting |
| Everything | `npm test` | GUI unit + host unit + host E2E + server |

CI (`.github/workflows/ci.yml`) runs all of the above plus the bundle
budget gate on every push/PR.
