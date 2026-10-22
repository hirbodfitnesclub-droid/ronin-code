import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser } from './helpers.mjs';

/**
 * First-login onboarding (migration 5): POST /api/me/onboarding saves
 * name + acquisition source (+ optional goal) atomically and flips
 * `onboarded`; a second submit is a harmless overwrite.
 */

let stack;
before(async () => { stack = await startStack(); });
after(async () => { await stack.close(); });

test('onboarding: gates, saves fields, flips flag, resubmit overwrites', async () => {
  const session = await loginUser(stack, '09120000444');
  const token = session.accessToken;

  // Fresh user is NOT onboarded (verify response + /api/me agree).
  assert.equal(session.user.onboarded, false);
  const me0 = await req(stack.base, '/api/me', { token });
  assert.equal(me0.json.user.onboarded, false);
  assert.equal(me0.json.user.acquisitionSource, null);

  // Unauthenticated is refused.
  const anon = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', body: { name: 'Sara', acquisitionSource: 'instagram' },
  });
  assert.equal(anon.status, 401);

  // Validation: name required, source must be a known chip, goal likewise.
  const noName = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', token, body: { acquisitionSource: 'instagram' },
  });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, 'name_required');
  const badSource = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', token, body: { name: 'Sara', acquisitionSource: 'mars' },
  });
  assert.equal(badSource.status, 400);
  assert.equal(badSource.json.error.code, 'invalid_source');
  const badGoal = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', token, body: { name: 'Sara', acquisitionSource: 'instagram', onboardingGoal: 'world_domination' },
  });
  assert.equal(badGoal.status, 400);
  assert.equal(badGoal.json.error.code, 'invalid_goal');

  // Happy path: everything persists and the flag flips.
  const saved = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', token,
    body: { name: 'Sara Test', acquisitionSource: 'instagram', onboardingGoal: 'freelance' },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.user.name, 'Sara Test');
  assert.equal(saved.json.user.acquisitionSource, 'instagram');
  assert.equal(saved.json.user.onboardingGoal, 'freelance');
  assert.equal(saved.json.user.onboarded, true);

  const me1 = await req(stack.base, '/api/me', { token });
  assert.equal(me1.json.user.onboarded, true);
  assert.equal(me1.json.user.name, 'Sara Test');

  // Second submit: harmless overwrite (incl. clearing the optional goal).
  const again = await req(stack.base, '/api/me/onboarding', {
    method: 'POST', token,
    body: { name: 'Sara T.', acquisitionSource: 'google' },
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.user.acquisitionSource, 'google');
  assert.equal(again.json.user.onboardingGoal, null);
  assert.equal(again.json.user.onboarded, true);

  // …and the admin dossier surface carries the same fields.
  const row = await stack.db.one('SELECT name, acquisition_source, onboarding_goal, onboarded FROM public.users WHERE id = $1', [session.user.id]);
  assert.equal(row.acquisition_source, 'google');
  assert.equal(row.onboarded, true);
});
