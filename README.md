# Ronin Code — رونین کد

A beautiful, simple vibe-coding tool. Chat-first, with a live preview of your
project and visual — never textual — activity while the agent works.

Ronin Code is a local tool: a small Ronin host runs on your own machine and
serves the interface in your browser. Your code and your API keys never leave
your machine. There are no accounts and no subscriptions — you bring your own
provider key (BYOK).

## Requirements

- Node.js 22.19 or newer
- An API key from a supported provider (Anthropic, OpenAI, Google or
  OpenRouter), or any OpenAI-compatible custom endpoint — optional for
  trying the interface in Preview mode

## Run it (production)

From this folder:

```bash
npm run install:all   # first time only
npm run serve         # builds the interface and starts Ronin Code
```

Then open http://127.0.0.1:7331 in your browser. That's it — the host hands
the interface its private per-run session token automatically when it serves
the page.

## Run it (development)

Two terminals, from this folder:

```bash
npm run dev:host      # Ronin host with auto-restart, port 7331
npm run dev:gui       # interface dev server, port 5173
```

Open http://127.0.0.1:5173 — the dev server proxies the API, the preview and
the session-token script to the host, so it works exactly like production.

## First steps

1. On first run, a short onboarding walks you through language, provider key
   and your first project.
2. Click **Create starter project** — pick a tasteful template (studio
   landing, analytics dashboard, personal site) or the classic starter;
   Ronin Code scaffolds it under `~/ronin-projects/` with a live preview.
3. Describe what you want in plain words and press Enter.
4. While the agent works you will see visual activity only — an ambient
   presence, scanning files, streaming lines, a terminal pulse. No status
   text, no logs.
5. Afterwards a **Changes** card summarises what changed, with a real
   **Diff** view, **Undo**, and one-click named **checkpoints**.
6. To go live, open **Settings**, pick your provider, paste your API key and
   press **Test connection**, then Save. Without a key, Ronin Code runs in
   clearly-labelled **Preview mode**, which simulates the full flow without
   touching your files.

## v1 highlights

- **Trust layer** — commands and writes outside your project ask first
  (visual approval card). **Auto** mode in the header skips the asks;
  checkpoints and Undo stay on. `.env` files are protected by default,
  secrets are redacted from tool output before it reaches the model, and a
  per-project toggle can explicitly allow `.env` access.
- **Router brain** — several keys per provider with rotation, failure
  cooldowns and automatic failover on rate-limit / server errors, plus
  RTK-style compression of tool output (with a savings counter).
- **Cost center** — every turn is priced and shown on its Changes card and
  in the header session total; an optional budget cap warns and then
  blocks new turns.
- **Plan mode** — the agent first proposes a visual step plan; you approve
  (or reply to revise) and steps tick off live as it builds.
- **Idea section** — one line is enough: Ronin shapes audience, features
  and a build plan into cards, then builds it for real.
- **Publish** — download the project as a .zip or export a static `dist/`
  copy, with plain-language guidance on hosting and domains.
- **Bilingual** — full English / فارسی interface with RTL mirroring
  (Vazirmatn bundled locally), switchable in Settings or onboarding.
- **Windows app** — a Tauri shell under `desktop/` packages this exact
  interface + host into an NSIS installer (see `desktop/README.md`).

## Tests

```bash
node host/test/e2e.mjs   # 29 checks: real engine vs a mock provider —
                         # approvals, Auto, .env, redaction, RTK,
                         # failover, cost, plan mode, ideas
```

## Your data

Everything Ronin Code stores lives in `~/.ronin-code/`:

- `auth.json` — your provider keys (file permission 0600, never sent to the
  interface; the interface only ever sees a masked hint)
- `config.json` — selected provider and model
- `sessions/` — conversation sessions
- `snapshots/` — a snapshot of your project taken before every turn, which
  powers Undo

The host listens on 127.0.0.1 only and answers only to local requests
carrying your per-run session token.

## Layout

- `gui/` — the Ronin Code interface (React + Vite + TypeScript). It talks to
  the host only through one versioned local API, so the same interface is
  packaged into the desktop shell unchanged.
- `host/` — the Ronin host (Node). Serves the interface, the project preview
  and the API; runs the coding engine in-process; owns keys, sessions,
  snapshots, approvals, routing and usage.
- `desktop/` — the Tauri v2 Windows shell (sidecar host, NSIS installer,
  updater wiring) and the release staging script.
