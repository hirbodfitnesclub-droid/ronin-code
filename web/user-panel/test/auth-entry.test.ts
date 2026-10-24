import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelEntryRoute } from '../src/lib/view.ts';

/* Bug 1 regression: the panel root used to render the shell whenever a
   session existed, so a visit from the desktop app (?from=app) by an
   already-signed-in user never reached the return-code screen — the
   app login dead-ended with no code shown. panelEntryRoute is the
   decision the root renders from; the already-signed-in + from-app
   cell is the one that was missing. */

test('entry: no session → auth, regardless of origin', () => {
  assert.equal(panelEntryRoute({ hasSession: false, onboarded: false, fromApp: false }), 'auth');
  assert.equal(panelEntryRoute({ hasSession: false, onboarded: false, fromApp: true }), 'auth');
});

test('entry: existing session + from app → handoff (the Bug 1 cell)', () => {
  assert.equal(panelEntryRoute({ hasSession: true, onboarded: true, fromApp: true }), 'handoff');
  // Handoff outranks onboarding: returning to the app is the intent.
  assert.equal(panelEntryRoute({ hasSession: true, onboarded: false, fromApp: true }), 'handoff');
});

test('entry: existing session, normal visit → onboarding gate, then shell', () => {
  assert.equal(panelEntryRoute({ hasSession: true, onboarded: false, fromApp: false }), 'onboarding');
  assert.equal(panelEntryRoute({ hasSession: true, onboarded: true, fromApp: false }), 'shell');
});

test('entry: "continue to panel" skip returns a from-app visit to the normal flow', () => {
  assert.equal(
    panelEntryRoute({ hasSession: true, onboarded: true, fromApp: true, skipHandoff: true }),
    'shell',
  );
  assert.equal(
    panelEntryRoute({ hasSession: true, onboarded: false, fromApp: true, skipHandoff: true }),
    'onboarding',
  );
});
