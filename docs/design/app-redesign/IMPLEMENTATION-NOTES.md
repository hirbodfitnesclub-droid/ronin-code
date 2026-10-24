# Implementation Notes — Ronin Code Desktop Redesign (Concept 2 / Agent Focus)

Built phase by phase against `PRD-FA.md` (redesign PRD v1.0), whose §1 authority
order puts product PRD v1.1 first and treats the 8 boards as form/layout
reference only. GUI only — no host/server/web changes.

## Verified API facts (checked against `gui/src/lib/api.ts` + host routes before designing)

- **No recent-projects endpoint** exists on the host. Home can only know the
  currently open project (`status.project`).
- **No turn-cancel endpoint** exists (`/api/turn` POST only; no stop/abort in
  host routes or turns). A composer Stop button cannot be wired to anything real.
- **Composer attachments**: `startTurn` accepts prompt + model/effort/fast only —
  no attachment channel exists.
- **Changed-file actions** produced by the host snapshot diff are only
  `created` / `modified` (deletions are not detected), so Changes groups by the
  actions actually present.
- **Manual checkpoints ARE real**: `POST /api/checkpoints` creates one and
  `api.createCheckpoint` already existed — the create affordance is kept.
- **Handoff code format** is `RNC-XXXX-XXXX` (4+4 chars, restricted alphabet,
  dashes/spaces stripped server-side, 10-min TTL) — the segmented input is
  built to exactly this shape.
- Subscription `status` is a server string (`active` / non-active states);
  balance/usage shown in-app come from `status.auth.subscription` + `/api/usage`.

---

## Phase 1 — Foundation + Shell + Home (RDX-03)

**Built**
- Density pass (P0): base font 14.5px → **13px**; buttons 30px tall (sm 28px),
  radius 999px → 10px controls; header 54px → 46px; chat bubbles 8/12px padding,
  14px radius; composer box radius 16px, send 30px; preview bar 42px → 36px;
  approval/plan cards padding ≤14px; form inputs 30px tall, 13px; login card
  padding 26/24, radius 16; onboarding card padding 26, h1 20px; empty-state
  hero clamped to 30px; starters/cards tightened. Tokens untouched
  (`tokens.css` already matches PRD §6.2 exactly).
- New shell: compact app bar (wordmark button → Home, current project + LTR
  path, Plan/Auto pills, **Publish always visible**, mode badge, session model,
  overflow ⋯ menu with open-project / starters / idea / checkpoints, settings,
  account/balance chip) + **nav rail** at the inline-end edge (Home, Workspace,
  Idea, Starters, Settings, collapse toggle; 216px ↔ 52px icon rail, persisted)
  + persistent **Auto banner** with consequence copy and a turn-off action.
- Resizable chat column: drag divider, 480–640px clamp (PRD §6.1), persisted;
  preview takes the remaining width; FA chat right / preview left, EN mirrored
  via logical layout.
- Loading state: calm branded splash while the first status load is in flight.
- **Home screen (new)**: hero «می‌خواهی چه بسازی؟», big desktop composer
  (textarea + family model picker with effort/Fast + send) wired to really
  start — App creates a starter project when none is open, switches to the
  workspace and sends the first turn; four discoverable paths (direct build →
  focuses the composer; idea → Idea panel; template → Starters; open existing
  → project picker); session model selectable via the shared picker; honest
  "no models enabled" guidance with a Settings shortcut; preview-mode note.

**Deviations**
- *Recent projects list* (board 01): the host has no recents API (see facts
  above). Home shows a single **"Continue" card for the currently open
  project** (real name + LTR path) and an honest empty state otherwise.
  API gap — needs a host `/api/projects/recent` to do more.
- *Board 01 sidebar user/balance block*: kept in the app bar account chip
  (existing, richer: panel link, refresh, logout) instead of duplicating it
  in the rail.
- *Board 01 global search box*: no search capability exists in the app —
  omitted rather than faked.

**Gates**: `npm run typecheck` ✓ · `npm test` 27/27 ✓ · `npm run build` ✓

---

## Phase 2 — Auth (RDX-01) + Onboarding (RDX-02)

**Built**
- Login rebuilt as five explicit states in board 03's visual language:
  **start** (primary «ورود با مرورگر» CTA + both fallbacks discoverable from
  the first screen), **waiting** (calm pulsing indicator, cancel, fallbacks
  stay reachable — and the app now *polls* `GET /api/auth` every 2.5s while
  waiting, so a completed panel sign-in lands automatically even when the
  deep link is missed), **manual code** (segmented 8-box `RNC-XXXX-XXXX`
  input: paste anywhere distributes, arrows/backspace navigate; distinct
  invalid vs expired vs used errors in PRD §8 copy; expired/used swaps the
  back link for a «دریافت کد جدید» action that reopens the panel),
  **OTP phone**, **OTP code** (6 digit boxes, 60s resend countdown then a
  real resend, edit-number path). No Google/email/password/guest anywhere.
- New pure helpers `lib/codeInput.ts` (normalise/format/completeness for the
  handoff code + OTP) with 4 new unit tests.
- Onboarding collapsed from the 2-step wizard to **one page**: models grid
  (provider-grouped cards, existing `ModelMultiSelect`) beside a side column
  with **Dark/Light theme cards** (live preview on pick, token-faithful
  mini-previews), the existing language cards, and the start action.
  Honest disabled guidance when no model is picked; when the account has
  **neither credit nor a BYOK key**, a note offers the two real doors —
  buy credit in the panel / finish into Settings to add a key.

**Deviations**
- Board 02's right column also shows plan/account teasers — omitted: no
  plans exist and the account lives in the panel (PRD authority order).
- The waiting state's auto-return depends on the host session flipping;
  polling is additive to the existing deep-link path, not a replacement.

**Gates**: `npm run typecheck` ✓ · `npm test` 31/31 ✓ · `npm run build` ✓
