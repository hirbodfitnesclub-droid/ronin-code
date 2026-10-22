# Changelog

All notable changes to Ronin Code are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-22

First release. A calm, visual vibe-coding studio: describe what you want,
watch it get built live, keep full control of keys, cost, and changes.

### Added

- **Desktop app** — Tauri v2 Windows shell (NSIS installer) around the
  local GUI + host; the same GUI runs standalone in a browser for dev.
- **Embedded agent engine** — sessions, tools, and streaming activity
  rendered as visual motion states (thinking, planning, reading, writing,
  editing, terminal, searching, reviewing) instead of text status lines.
- **Trust layer** — approval gate for shell commands and writes outside
  the project (10-minute auto-deny), explicit Auto mode, hard block on
  `.env` access, secret redaction in tool output, snapshot-based Undo and
  named checkpoints with restore.
- **Router brain** — multiple API keys per provider with LRU rotation and
  cooldowns, ordered provider failover on retryable errors, RTK output
  compression with a savings counter, per-session cost center with a
  budget cap.
- **Plan mode** — the agent proposes a plan card first; approve to build
  with live step progress, reply in chat to revise.
- **Idea mode** — one line in; audience, pain, features, and a build plan
  out; one click to start building.
- **Starters & publish** — tasteful starter projects, one-click zip /
  static-dist export with bilingual next-steps guidance.
- **Bilingual EN/FA** — full UI translation, RTL mirroring with LTR
  islands for code/paths, bundled Vazirmatn font, first-run onboarding.
- **Subscription server** — phone + SMS OTP login (Kavenegar), refresh
  rotation with reuse detection, append-only credit ledger with FIFO
  lots and expiry, card-to-card payment claims with atomic idempotent
  approval, hold/commit metering proxy, standalone admin app with its
  own login and audit trail.
- **Quality charter** — React ErrorBoundary with bilingual fallback and
  host-side crash reporting, structured secret-free JSON logging,
  ESLint + Prettier, unit tests for all pure logic, CI running lint,
  typecheck, unit suites, host E2E, and server tests, plus a 300 KB
  gzipped-JS bundle budget gate.

### Architecture

- Host service modularized into single-responsibility modules
  (config, guard, router, cost, engine, turns, snapshots, publish, http).
- Frontend restructured to a feature-based architecture (features/,
  components/ui, hooks/, lib/) with zero behavior or visual change.
  See ARCHITECTURE.md.
