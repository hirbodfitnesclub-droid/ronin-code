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

1. Click **Create starter project** — Ronin Code scaffolds a small web app
   under `~/ronin-projects/` and opens its live preview.
2. Describe what you want in plain words and press Enter.
3. While the agent works you will see visual activity only — an ambient
   presence, scanning files, streaming lines, a terminal pulse. No status
   text, no logs.
4. Afterwards a **Changes** card summarises what changed, with **Undo** to
   roll the whole turn back and **Details** if you want the plain file list.
5. To go live, open **Settings**, pick your provider, paste your API key and
   press **Test connection**, then Save. Without a key, Ronin Code runs in
   clearly-labelled **Preview mode**, which simulates the full flow without
   touching your files.

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
  the host only through one versioned local API, so the same interface can
  later be packaged into a desktop shell unchanged.
- `host/` — the Ronin host (Node). Serves the interface, the project preview
  and the API; runs the coding engine in-process; owns keys, sessions and
  snapshots.
