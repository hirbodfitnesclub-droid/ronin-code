import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startStack, req, loginUser } from './helpers.mjs';

// Handoff return codes: a signed-in panel user mints a one-time code; the
// desktop app exchanges it for OUR OWN app session (GoTrue generate_link is
// email-only, verified on the pinned binary). App sessions authenticate
// through the same device registry and rotate locally with reuse detection.
// Each test logs in its own user so device-cap effects stay isolated.
let stack;

before(async () => { stack = await startStack(); });
after(() => stack.close());

const issue = (token) => req(stack.base, '/api/auth/handoff', { method: 'POST', token, body: {} });
const exchange = (code, deviceName = 'desktop-app') =>
  req(stack.base, '/api/auth/handoff/exchange', { method: 'POST', body: { code, deviceName } });

test('issue requires auth; exchange mints a working app session for the same user', async () => {
  const anon = await issue(null);
  assert.equal(anon.status, 401);

  const user = await loginUser(stack, '09120000501');
  const issued = await issue(user.accessToken);
  assert.equal(issued.status, 200);
  assert.match(issued.json.code, /^RNC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(issued.json.expiresInSec, 600);

  const ex = await exchange(issued.json.code);
  assert.equal(ex.status, 200, ex.text);
  assert.ok(ex.json.accessToken && ex.json.refreshToken && ex.json.deviceId);
  assert.equal(ex.json.accessExpiresInSec, 900);
  assert.equal(ex.json.user.id, user.user.id);

  const me = await req(stack.base, '/api/me', { token: ex.json.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, user.user.id);
});

test('app refresh rotates locally; reuse of the rotated token revokes the device', async () => {
  const user = await loginUser(stack, '09120000502');
  const issued = await issue(user.accessToken);
  const ex = await exchange(issued.json.code);
  assert.equal(ex.status, 200);

  const r1 = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: ex.json.refreshToken } });
  assert.equal(r1.status, 200, r1.text);
  assert.notEqual(r1.json.refreshToken, ex.json.refreshToken);
  // The rotated pair works.
  const me = await req(stack.base, '/api/me', { token: r1.json.accessToken });
  assert.equal(me.status, 200);

  // Presenting the OLD refresh token again → reuse → whole device revoked.
  const reuse = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: ex.json.refreshToken } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.json.error.code, 'refresh_reuse');
  const after = await req(stack.base, '/api/me', { token: r1.json.accessToken });
  assert.equal(after.status, 401);
});

test('a code exchanges exactly once; a wrong code is invalid_code', async () => {
  const user = await loginUser(stack, '09120000503');
  const issued = await issue(user.accessToken);
  const first = await exchange(issued.json.code);
  assert.equal(first.status, 200);
  const second = await exchange(issued.json.code);
  assert.equal(second.status, 400);
  assert.equal(second.json.error.code, 'code_used');

  const wrong = await exchange('RNC-XXXX-XXXX');
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'invalid_code');
});

test('expired code → code_expired', async () => {
  const user = await loginUser(stack, '09120000504');
  const code = 'RNC-ABCD-2345';
  const normalized = code.toUpperCase().replace(/[-\s]/g, '');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  await stack.db.query(
    'INSERT INTO public.handoff_codes (user_id, code_hash, expires_at) VALUES ($1,$2, now() - interval \'1 minute\')',
    [user.user.id, hash]);
  const r = await exchange(code);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'code_expired');
});

test('device cap: handoff logins beyond the cap revoke the oldest device', async () => {
  const u = await loginUser(stack, '09120000444', 'panel-device'); // device 1 (gotrue)
  const issued1 = await issue(u.accessToken);
  assert.equal(issued1.status, 200);
  const ex1 = await exchange(issued1.json.code, 'desktop-1'); // device 2
  assert.equal(ex1.status, 200);
  const issued2 = await issue(u.accessToken);
  assert.equal(issued2.status, 200);
  const ex2 = await exchange(issued2.json.code, 'desktop-2'); // device 3 → cap 2 revokes the oldest
  assert.equal(ex2.status, 200);

  const devices = await req(stack.base, '/api/devices', { token: ex2.json.accessToken });
  assert.equal(devices.status, 200);
  assert.equal(devices.json.devices.filter((d) => d.active).length, 2);
  // The oldest (panel/gotrue) device is the one that was revoked.
  const oldest = devices.json.devices.find((d) => d.id === u.deviceId);
  assert.equal(oldest.active, false);
  const stale = await req(stack.base, '/api/me', { token: u.accessToken });
  assert.equal(stale.status, 401);
});
