import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser, loginAdmin, postClaim } from './helpers.mjs';
import { createWorker } from '../src/reseller/worker.js';
import { registerInlineProcessor, processInlineIntents } from '../src/reseller/intents.js';
import { setSetting } from '../src/settings.js';

/**
 * Workstream B — INLINE issuance (the Vercel topology): no resident worker,
 * no worker kick. The admin handler itself must drain a mutation's intents
 * synchronously (via the registered inline processor) before responding, so
 * by the time an approval/charge/toggle/refund response returns, the intent
 * is already terminal. The processor registered here mirrors the Vercel
 * function entry (web/admin-panel/api/index.js): a bounded worker drain.
 * No test in this file ever calls drainOnce() directly.
 */

let stack, owner, user, user2;
const mock = () => stack.mockCvc.state;
const asOwner = (p, opts = {}) => req(stack.adminBase, p, { cookie: owner.cookie, csrf: owner.csrf, ...opts });

async function keyRow(userId) {
  return stack.db.one('SELECT * FROM public.user_provider_keys WHERE user_id = $1', [userId]);
}
async function intentsFor(userId, kind = null) {
  return kind
    ? stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 AND kind = $2 ORDER BY id', [userId, kind])
    : stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 ORDER BY id', [userId]);
}
async function approveClaimFor(u) {
  const created = await postClaim(stack.base, u.accessToken, 'pack-1');
  assert.equal(created.status, 201, created.text);
  const reviewed = await asOwner(`/admin-api/orders/${created.json.order.id}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(reviewed.status, 200, reviewed.text);
  return { orderId: created.json.order.id, reviewed: reviewed.json };
}

before(async () => {
  stack = await startStack({ mockCvc: true });
  owner = await loginAdmin(stack);
  user = await loginUser(stack, '09128880001');
  user2 = await loginUser(stack, '09128880002');
  await setSetting(stack.db, 'subscription_routing', { mode: 'shared', allowlist: [user.user.id, user2.user.id] });
  // The Vercel wiring: inline processor only. Deliberately NO
  // registerWorkerKick and NO worker.start() — nothing resident exists.
  registerInlineProcessor(async () => { await createWorker(stack.db, stack.cfg).drainOnce(); });
});

after(async () => {
  registerInlineProcessor(null);
  await stack.close();
});

test('inline: order approval issues the key before the response returns', async () => {
  const { reviewed } = await approveClaimFor(user);
  assert.equal(reviewed.issuance.state, 'pending'); // state at insert time, as reported
  const intent = (await intentsFor(user.user.id, 'create'))[0];
  assert.equal(intent.state, 'confirmed', 'intent must be terminal by the time the review response returned');
  const row = await keyRow(user.user.id);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.token_limit_issued), 1000);
  assert.equal(mock().calls.create, 1);
});

test('inline: manual charge tops up before the response returns', async () => {
  const r = await asOwner(`/admin-api/users/${user.user.id}/charge`, {
    method: 'POST', body: { tokens: 250, note: 'inline charge test' },
  });
  assert.equal(r.status, 200, r.text);
  const intent = (await intentsFor(user.user.id, 'topup')).at(-1);
  assert.equal(intent.state, 'confirmed');
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 1250);
});

test('inline: refund reduces the provider limit before the response returns', async () => {
  const orders = await asOwner('/admin-api/orders?status=approved');
  const first = orders.json.orders.find((o) => o.userId === user.user.id);
  const r = await asOwner(`/admin-api/orders/${first.id}/refund`, {
    method: 'POST',
    body: { amountRials: 1_400_000, reason: 'inline refund test', idempotencyKey: `refund-inline-${first.id}` },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.tokensRemoved, 500);
  const intent = (await intentsFor(user.user.id, 'reduce')).at(-1);
  assert.equal(intent.state, 'confirmed');
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 750);
});

test('inline: suspend freezes and reactivate unfreezes before the responses return', async () => {
  const off = await asOwner(`/admin-api/users/${user.user.id}/toggle-active`, {
    method: 'POST', body: { isActive: false },
  });
  assert.equal(off.status, 200, off.text);
  let row = await keyRow(user.user.id);
  assert.equal(row.status, 'frozen');
  assert.equal(mock().recByName(row.provider_key_name).is_active, false);

  const on = await asOwner(`/admin-api/users/${user.user.id}/toggle-active`, {
    method: 'POST', body: { isActive: true },
  });
  assert.equal(on.status, 200, on.text);
  row = await keyRow(user.user.id);
  assert.equal(row.status, 'active');
  assert.equal(mock().recByName(row.provider_key_name).is_active, true);
});

test('inline: a failing processor never fails the admin request; the intent stays pending', async () => {
  registerInlineProcessor(async () => { throw new Error('processor boom'); });
  try {
    const { reviewed } = await approveClaimFor(user2);
    assert.equal(reviewed.issuance.state, 'pending');
    const intent = (await intentsFor(user2.user.id, 'create'))[0];
    assert.equal(intent.state, 'pending', 'a failed inline drain leaves the intent for the sweep/retry net');
    assert.equal((await keyRow(user2.user.id))?.encrypted_key ?? null, null);
  } finally {
    registerInlineProcessor(async () => { await createWorker(stack.db, stack.cfg).drainOnce(); });
  }
  // The safety net converges it: an explicit inline pass (what the daily
  // sweep's drain does) issues exactly one key.
  await processInlineIntents(user2.user.id);
  const intent = (await intentsFor(user2.user.id, 'create'))[0];
  assert.equal(intent.state, 'confirmed');
  assert.equal(Number((await keyRow(user2.user.id)).token_limit_issued), 1000);
});
