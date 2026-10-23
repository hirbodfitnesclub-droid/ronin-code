import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser, loginAdmin, postClaim, grant, USER_PHONE } from './helpers.mjs';
import { MOCK_PRIMARY } from './mock-cvc.mjs';
import { createWorker } from '../src/reseller/worker.js';
import { createResellerClient } from '../src/reseller/client.js';
import { encryptDelegatedKey, decryptDelegatedKey, fingerprintOf } from '../src/reseller/crypto.js';
import { setSetting } from '../src/settings.js';
import { insertIntent } from '../src/reseller/intents.js';
import { reserveHold, releaseHold } from '../src/ledger.js';

/**
 * Phase 2 per-user provider keys — design §12.1/§12.2 against the mock CVC
 * provider (contract-faithful, with ambiguous-timeout fault injection).
 * The REAL provider is never called in tests.
 */

let stack, owner, worker;
const mock = () => stack.mockCvc.state;
const asOwner = (p, opts = {}) => req(stack.adminBase, p, { cookie: owner.cookie, csrf: owner.csrf, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setRouting(doc) {
  await setSetting(stack.db, 'subscription_routing', doc);
}
async function keyRow(userId) {
  return stack.db.one('SELECT * FROM public.user_provider_keys WHERE user_id = $1', [userId]);
}
async function intentsFor(userId, kind = null) {
  return kind
    ? stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 AND kind = $2 ORDER BY id', [userId, kind])
    : stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 ORDER BY id', [userId]);
}
async function approveClaimFor(user, packId = 'pack-1') {
  const created = await postClaim(stack.base, user.accessToken, packId);
  assert.equal(created.status, 201, created.text);
  const reviewed = await asOwner(`/admin-api/orders/${created.json.order.id}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(reviewed.status, 200, reviewed.text);
  return reviewed.json;
}
const chatAs = (token, body, headers) =>
  req(stack.base, '/v1/chat/completions', { method: 'POST', token, body, headers });

let userA, userB, userC, userD, userE, userF, userG, userH, userI, userJ;
let plainA; // user A's delegated plaintext, read from the MOCK (never logged)

before(async () => {
  stack = await startStack({ mockCvc: true });
  owner = await loginAdmin(stack);
  worker = createWorker(stack.db, stack.cfg);
  userA = await loginUser(stack, USER_PHONE);
  // Routing: shared globally, A/B allowlisted (staged rollout, §11 stage 1–2)
  await setRouting({ mode: 'shared', allowlist: [userA.user.id] });
});

after(() => stack.close());

test('encryption: round-trip, AAD row-swap fails, wrong key fails, v1: format', () => {
  const cfg = stack.cfg;
  const ct = encryptDelegatedKey(cfg, 'sk-ronin-fake-1234', { userId: 'u-1', keyRowId: 42 });
  assert.match(ct, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decryptDelegatedKey(cfg, ct, { userId: 'u-1', keyRowId: 42 }), 'sk-ronin-fake-1234');
  assert.throws(() => decryptDelegatedKey(cfg, ct, { userId: 'u-2', keyRowId: 42 }));
  assert.throws(() => decryptDelegatedKey(cfg, ct, { userId: 'u-1', keyRowId: 43 }));
  const wrongCfg = { ...cfg, cvcKeyEncryptionKey: Buffer.alloc(32, 9).toString('base64') };
  assert.throws(() => decryptDelegatedKey(wrongCfg, ct, { userId: 'u-1', keyRowId: 42 }));
  assert.ok(!ct.includes('sk-ronin-fake'));
});

test('shared mode: approval creates NO intent and credential endpoint stays shared', async () => {
  userG = await loginUser(stack, '09127770001');
  const reviewed = await approveClaimFor(userG);
  assert.equal(reviewed.issuance.state, 'not_applicable');
  assert.equal((await intentsFor(userG.user.id)).length, 0);
  const cred = await req(stack.base, '/api/subscription/credential', { token: userG.accessToken });
  assert.deepEqual(cred.json, { routingMode: 'shared' });
});

test('approval → create intent → worker issues key; ciphertext only in DB; credential endpoint delivers it', async () => {
  const reviewed = await approveClaimFor(userA);
  assert.equal(reviewed.grantedTokens, 1000); // pack-1: 1 × tokensPerUsd(1000) in test cfg
  assert.equal(reviewed.issuance.state, 'pending');
  assert.equal(reviewed.issuance.kind, 'create');

  const out = await worker.drainOnce();
  assert.ok(out.processed >= 1);
  const row = await keyRow(userA.user.id);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.token_limit_issued), 1000);
  assert.ok(row.encrypted_key.startsWith('v1:'));
  plainA = mock().byName(row.provider_key_name);
  assert.ok(plainA, 'mock must hold the created key under its provider name');
  assert.ok(!row.encrypted_key.includes(plainA));
  assert.equal(row.key_fingerprint, fingerprintOf(plainA));
  assert.equal(row.key_last4, plainA.slice(-4));
  assert.equal(mock().calls.create, 1);

  const intent = (await intentsFor(userA.user.id, 'create'))[0];
  assert.equal(intent.state, 'confirmed');
  assert.ok(!JSON.stringify(intent.attempts).includes(plainA), 'plaintext must never appear in attempt logs');

  const cred = await req(stack.base, '/api/subscription/credential', { token: userA.accessToken });
  assert.equal(cred.status, 200);
  assert.equal(cred.headers.get('cache-control'), 'no-store');
  assert.equal(cred.json.routingMode, 'per_user');
  assert.equal(cred.json.keyStatus, 'active');
  assert.equal(cred.json.delegatedKey, plainA);
  assert.equal(cred.json.tokenLimitIssued, 1000);
});

test('thin relay: session-Bearer and delegated-Bearer both forward with the user key; fast converts; no shared upstream call', async () => {
  const upstreamBefore = stack.upstream.state.calls;
  const chatBefore = mock().calls.chat;
  const r1 = await chatAs(userA.accessToken, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(mock().lastChatAuth, `Bearer ${plainA}`);
  const r2 = await chatAs(plainA, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(mock().calls.chat, chatBefore + 2);
  assert.equal(stack.upstream.state.calls, upstreamBefore, 'per-user path must not touch the shared upstream');

  const r3 = await chatAs(userA.accessToken,
    { model: 'gpt-5.6-terra', ronin_fast: true, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-ronin-fast': '1' });
  assert.equal(r3.status, 200);
  assert.equal(mock().lastChatBody.service_tier, 'priority');
  assert.equal(mock().lastChatBody.ronin_fast, undefined);

  // account-status substitutes provider balance in per-user mode
  const status = await req(stack.base, '/api/account-status', { token: userA.accessToken });
  assert.equal(status.json.routingMode, 'per_user');
  assert.equal(status.json.providerKey.status, 'active');
  assert.equal(status.json.spendableTokens, status.json.balanceTokens);
  assert.deepEqual(status.json.lots, []);
});

test('second purchase tops up the SAME key additively', async () => {
  const createsBefore = mock().calls.create;
  const reviewed = await approveClaimFor(userA);
  assert.equal(reviewed.issuance.kind, 'topup');
  await worker.drainOnce();
  const row = await keyRow(userA.user.id);
  assert.equal(Number(row.token_limit_issued), 2000);
  assert.equal(mock().calls.create, createsBefore, 'no new key may be created');
  assert.equal(mock().recByName(row.provider_key_name).token_limit, 2000);
});

test('provider 402 → relay insufficient_credit envelope', async () => {
  const rec = mock().recByName((await keyRow(userA.user.id)).provider_key_name);
  rec.tokens_used = rec.token_limit; // exhaust allowance provider-side
  const r = await chatAs(userA.accessToken, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'insufficient_credit');
  rec.tokens_used = 0; // restore for later tests
});

test('suspend → freeze intent → frozen; reactivate → unfreeze', async () => {
  const t = await asOwner(`/admin-api/users/${userA.user.id}/toggle-active`, { method: 'POST', body: { isActive: false } });
  assert.equal(t.status, 200, t.text);
  await worker.drainOnce();
  let row = await keyRow(userA.user.id);
  assert.equal(row.status, 'frozen');
  assert.equal(mock().recByName(row.provider_key_name).is_active, false);
  // A delegated-key call against a frozen key is refused locally as suspended
  const blocked = await chatAs(plainA, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'account_suspended');

  const t2 = await asOwner(`/admin-api/users/${userA.user.id}/toggle-active`, { method: 'POST', body: { isActive: true } });
  assert.equal(t2.status, 200);
  await worker.drainOnce();
  row = await keyRow(userA.user.id);
  assert.equal(row.status, 'active');
  assert.equal(mock().recByName(row.provider_key_name).is_active, true);
});

test('refund → reduce intent lowers the provider limit by exactly tokensRemoved', async () => {
  // order list: A has two approved orders; refund half of the first (price
  // snapshot from DEFAULT_PACKS pack-1 = 2_800_000 rials → half = 500 tokens)
  const orders = await asOwner('/admin-api/orders?status=approved');
  const first = orders.json.orders.find((o) => o.userId === userA.user.id);
  const r = await asOwner(`/admin-api/orders/${first.id}/refund`, {
    method: 'POST',
    body: { amountRials: 1_400_000, reason: 'refund test reason', idempotencyKey: `refund-A-${first.id}` },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.tokensRemoved, 500);
  await worker.drainOnce();
  const row = await keyRow(userA.user.id);
  assert.equal(Number(row.token_limit_issued), 1500);
  assert.equal(mock().recByName(row.provider_key_name).token_limit, 1500);
  const reduce = (await intentsFor(userA.user.id, 'reduce'))[0];
  assert.equal(reduce.state, 'confirmed');
  assert.equal(reduce.source, 'refund');
});

test('ambiguous create → needs_attention, NEVER retried; replacement issues exactly one new key', async () => {
  userB = await loginUser(stack, '09127770002');
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id] });
  await approveClaimFor(userB);
  mock().faults.createAmbiguous = 1; // provider commits, response hangs
  const createsBefore = mock().calls.create;
  await worker.drainOnce();
  assert.equal(mock().calls.create, createsBefore + 1);
  const intent = (await intentsFor(userB.user.id, 'create'))[0];
  assert.equal(intent.state, 'needs_attention');
  await worker.drainOnce(); // must NOT re-dispatch
  assert.equal(mock().calls.create, createsBefore + 1);
  const flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_key_attention' AND status = 'open'", [userB.user.id]);
  assert.equal(flags.length, 1);

  const resolved = await asOwner(`/admin-api/provider/intents/${intent.id}/resolve`, {
    method: 'POST', body: { decision: 'create_replacement' },
  });
  assert.equal(resolved.status, 200, resolved.text);
  await worker.drainOnce();
  assert.equal(mock().calls.create, createsBefore + 2, 'exactly one replacement key');
  const row = await keyRow(userB.user.id);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.token_limit_issued), 1000);
});

test('ambiguous top-up → needs_attention with NO double-add; mark_applied converges bookkeeping', async () => {
  const charge = await asOwner(`/admin-api/users/${userB.user.id}/charge`, {
    method: 'POST', body: { tokens: 100, note: 'topup ambiguity test' },
  });
  assert.equal(charge.status, 200, charge.text);
  const recBefore = mock().recByName((await keyRow(userB.user.id)).provider_key_name).token_limit;
  mock().faults.editAmbiguous = 1;
  await worker.drainOnce();
  const intent = (await intentsFor(userB.user.id, 'topup')).at(-1);
  assert.equal(intent.state, 'needs_attention');
  assert.equal(mock().recByName((await keyRow(userB.user.id)).provider_key_name).token_limit, recBefore + 100,
    'the mock committed exactly one add');
  assert.equal(Number((await keyRow(userB.user.id)).token_limit_issued), 1000, 'our bookkeeping not yet updated');
  assert.notEqual(intent.balance_before, null, 'pre-op snapshot must be recorded as evidence');

  const resolved = await asOwner(`/admin-api/provider/intents/${intent.id}/resolve`, {
    method: 'POST', body: { decision: 'mark_applied' },
  });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(Number((await keyRow(userB.user.id)).token_limit_issued), 1100);
  const edits = mock().calls.edit;
  await worker.drainOnce();
  assert.equal(mock().calls.edit, edits, 'mark_applied must not call the provider');
});

test('primary guard: edit targeting the primary key throws pre-dispatch', async () => {
  const client = createResellerClient(stack.cfg);
  const editsBefore = mock().calls.edit;
  await assert.rejects(
    () => client.editKey({ targetKey: MOCK_PRIMARY, fields: { active: false } }),
    (e) => e.code === 'primary_guard' || /primary_guard/.test(e.message));
  assert.equal(mock().calls.edit, editsBefore, 'guard must fire before any dispatch');
});

test('idempotent reduce retries after an ambiguous failure and lands exactly on target', async () => {
  const intent = await insertIntent(stack.db, {
    userId: userB.user.id, kind: 'reduce', source: 'reconcile_fix',
    idempotencyKey: `reduce-test:${userB.user.id}`, amountTokens: 100, actor: 'system:reconciler',
  });
  mock().faults.editAmbiguous = 1; // first dispatch commits, response hangs
  await worker.drainOnce();
  let fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
  assert.equal(fresh.state, 'pending', 'idempotent ops may retry');
  await sleep(100); // backoff base is 10ms in tests — wait it out generously
  await worker.drainOnce();
  fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
  assert.equal(fresh.state, 'confirmed');
  const row = await keyRow(userB.user.id);
  assert.equal(Number(row.token_limit_issued), 1000); // 1100 − 100, exactly once in effect
  assert.equal(mock().recByName(row.provider_key_name).token_limit, 1000);
});

test('provider down at approval: approval still succeeds; intent stays pending (connect = safe retry), then drains', async () => {
  userE = await loginUser(stack, '09127770005');
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id, userE.user.id] });
  const realUrl = stack.cfg.cvcBaseUrl;
  stack.cfg.cvcBaseUrl = 'http://127.0.0.1:59999'; // nothing listening → ECONNREFUSED (pre-dispatch)
  try {
    const reviewed = await approveClaimFor(userE);
    assert.equal(reviewed.issuance.state, 'pending');
    const w2 = createWorker(stack.db, stack.cfg);
    await w2.drainOnce();
    const intent = (await intentsFor(userE.user.id, 'create'))[0];
    assert.equal(intent.state, 'pending', 'pre-dispatch failure must be a safe retry, not needs_attention');
  } finally {
    stack.cfg.cvcBaseUrl = realUrl;
  }
  await sleep(100); // safe-retry backoff must elapse before the drain can claim it
  await worker.drainOnce();
  const row = await keyRow(userE.user.id);
  assert.equal(row.status, 'active');
});

test('coalescing: pending topup folds into a not-yet-dispatched create; suspended user create is cancelled', async () => {
  userI = await loginUser(stack, '09127770009');
  userJ = await loginUser(stack, '09127770010');
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id, userE.user.id, userI.user.id, userJ.user.id] });
  await insertIntent(stack.db, {
    userId: userI.user.id, kind: 'create', source: 'claim',
    idempotencyKey: `coal-create:${userI.user.id}`, amountTokens: 300, actor: 'system',
  });
  await insertIntent(stack.db, {
    userId: userI.user.id, kind: 'topup', source: 'claim',
    idempotencyKey: `coal-topup:${userI.user.id}`, amountTokens: 200, actor: 'system',
  });
  const createsBefore = mock().calls.create;
  await worker.drainOnce();
  assert.equal(mock().calls.create, createsBefore + 1);
  const rowI = await keyRow(userI.user.id);
  assert.equal(Number(rowI.token_limit_issued), 500);
  assert.equal((await intentsFor(userI.user.id, 'topup'))[0].state, 'superseded');

  await insertIntent(stack.db, {
    userId: userJ.user.id, kind: 'create', source: 'claim',
    idempotencyKey: `susp-create:${userJ.user.id}`, amountTokens: 300, actor: 'system',
  });
  await stack.db.query('UPDATE public.users SET is_active = false WHERE id = $1', [userJ.user.id]);
  const createsBefore2 = mock().calls.create;
  await worker.drainOnce();
  assert.equal(mock().calls.create, createsBefore2);
  assert.equal((await intentsFor(userJ.user.id, 'create'))[0].state, 'cancelled');
});

test('backfill sweeper: an approved order whose inline intent was lost still gets provisioned', async () => {
  userH = await loginUser(stack, '09127770008');
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id, userE.user.id, userI.user.id, userJ.user.id, userH.user.id] });
  await approveClaimFor(userH);
  // Simulate the §3.1 step-3 failure: inline intent insert never landed.
  await stack.db.query('DELETE FROM public.key_issuance_intents WHERE user_id = $1', [userH.user.id]);
  await worker.drainOnce({ sweep: true });
  const row = await keyRow(userH.user.id);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.token_limit_issued), 1000);
  // A second sweep creates no duplicates.
  const before = (await intentsFor(userH.user.id)).length;
  await worker.drainOnce({ sweep: true });
  assert.equal((await intentsFor(userH.user.id)).length, before);
});

test('conversion: exactly-once under concurrent triggers; amount = spendable; marker ledger row once', async () => {
  userC = await loginUser(stack, '09127770003');
  await grant(stack, userC.user.id, 700); // v1 balance under the shared system
  await setRouting({
    mode: 'shared',
    allowlist: [userA.user.id, userB.user.id, userE.user.id, userI.user.id, userJ.user.id, userH.user.id, userC.user.id],
  });
  const [s1, s2] = await Promise.all([
    req(stack.base, '/api/account-status', { token: userC.accessToken }),
    req(stack.base, '/api/account-status', { token: userC.accessToken }),
  ]);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  const convIntents = await intentsFor(userC.user.id, 'convert');
  assert.equal(convIntents.length, 1);
  assert.equal(Number(convIntents[0].amount_tokens), 700);
  const markers = await stack.db.many(
    "SELECT * FROM public.ledger WHERE user_id = $1 AND kind = 'convert'", [userC.user.id]);
  assert.equal(markers.length, 1);
  assert.equal(Number(markers[0].delta_tokens), 0);
  await worker.drainOnce();
  const row = await keyRow(userC.user.id);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.token_limit_issued), 700);
  assert.ok(row.converted_at);
  // Second trigger: no-op.
  await req(stack.base, '/api/account-status', { token: userC.accessToken });
  assert.equal((await intentsFor(userC.user.id, 'convert')).length, 1);
});

test('conversion defers while a hold is in flight, then completes after it settles', async () => {
  userD = await loginUser(stack, '09127770004');
  await grant(stack, userD.user.id, 500);
  const held = await reserveHold(stack.db, {
    userId: userD.user.id, requestId: 'conv-hold-1', model: 'm', multiplier: 1, reservedTokens: 100, actor: 'test',
  });
  assert.ok(held);
  await setRouting({
    mode: 'shared',
    allowlist: [userA.user.id, userB.user.id, userE.user.id, userI.user.id, userJ.user.id, userH.user.id, userC.user.id, userD.user.id],
  });
  await req(stack.base, '/api/account-status', { token: userD.accessToken });
  assert.equal((await intentsFor(userD.user.id, 'convert')).length, 0);
  assert.equal((await keyRow(userD.user.id))?.converted_at ?? null, null);
  await releaseHold(stack.db, { holdId: held.hold.id, reason: 'settled' });
  await req(stack.base, '/api/account-status', { token: userD.accessToken });
  const conv = await intentsFor(userD.user.id, 'convert');
  assert.equal(conv.length, 1);
  assert.equal(Number(conv[0].amount_tokens), 500);
});

test('reconciliation: usage accumulates once, daily rollup + summary endpoints, partial gap tracked, over-issuance flags once', async () => {
  userF = await loginUser(stack, '09127770006');
  await setRouting({
    mode: 'shared',
    allowlist: [userA.user.id, userB.user.id, userE.user.id, userI.user.id, userJ.user.id, userH.user.id, userC.user.id, userD.user.id, userF.user.id],
  });
  await approveClaimFor(userF);
  await worker.drainOnce();
  const row = await keyRow(userF.user.id);
  const plain = mock().byName(row.provider_key_name);
  mock().addLog(plain, { cost_tokens: 200, model: 'gpt-5.6-terra' });
  mock().addLog(plain, { cost_tokens: 300, model: 'gpt-5.6-terra' });

  await worker.reconcile();
  let fresh = await keyRow(userF.user.id);
  assert.equal(Number(fresh.tokens_used_observed), 500);
  await worker.reconcile(); // delta 0 → no double count
  fresh = await keyRow(userF.user.id);
  assert.equal(Number(fresh.tokens_used_observed), 500);

  const summary = await req(stack.base, '/api/usage/summary', { token: userF.accessToken });
  assert.equal(summary.status, 200);
  assert.ok(summary.json.todayTokens >= 500, `todayTokens=${summary.json.todayTokens}`);
  assert.ok(summary.json.topModels.some((m) => m.model === 'gpt-5.6-terra'));

  const recent = await req(stack.base, '/api/usage/recent', { token: userF.accessToken });
  assert.equal(recent.json.windowNote, 'recent_30');
  assert.equal(recent.json.totalRequests, 2);
  assert.equal(recent.json.rows.length, 2);

  // Over-issuance: provider-side limit inflated beyond what we issued (+200k
  // > ε = max(100k, 1% of 1000)) → U + B > L + ε.
  const rec = mock().recByName(row.provider_key_name);
  rec.token_limit += 200_000;
  await worker.reconcile();
  let flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'", [userF.user.id]);
  assert.equal(flags.length, 1);
  await worker.reconcile();
  flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'", [userF.user.id]);
  assert.equal(flags.length, 1, 'drift flags are deduped while open');
  rec.token_limit -= 200_000; // restore

  // Partial gap: 35 new logs at once → only newest 30 observable.
  for (let i = 0; i < 35; i++) mock().addLog(plain, { cost_tokens: 10 });
  await worker.reconcile();
  fresh = await keyRow(userF.user.id);
  assert.ok(Number(fresh.logs_gap_rows) >= 5);
  const snap = await stack.db.one(
    'SELECT * FROM public.key_usage_snapshots WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userF.user.id]);
  assert.equal(snap.partial, true);
});

test('admin provider-key dossier + routing flag endpoints + close flow deletes the key', async () => {
  const dossier = await asOwner(`/admin-api/users/${userF.user.id}/provider-key`);
  assert.equal(dossier.status, 200, dossier.text);
  assert.equal(dossier.json.providerKey.status, 'active');
  assert.equal(dossier.json.providerKey.tokenLimitIssued, 1000);
  assert.ok(Array.isArray(dossier.json.intents));

  const routing = await asOwner('/admin-api/settings/subscription-routing', {
    method: 'PUT', body: { mode: 'shared', allowlist: [userF.user.id] },
  });
  assert.equal(routing.status, 200, routing.text);

  const badClose = await asOwner(`/admin-api/users/${userF.user.id}/close`, {
    method: 'POST', body: { confirmPhone: '09000000000', note: 'closing test account' },
  });
  assert.equal(badClose.status, 400);
  const userRow = await stack.db.one('SELECT phone FROM public.users WHERE id = $1', [userF.user.id]);
  const closed = await asOwner(`/admin-api/users/${userF.user.id}/close`, {
    method: 'POST', body: { confirmPhone: userRow.phone, note: 'closing test account' },
  });
  assert.equal(closed.status, 200, closed.text);
  await worker.drainOnce();
  const row = await keyRow(userF.user.id);
  assert.equal(row.status, 'deleted');
  assert.equal(row.encrypted_key, null);
  assert.equal(row.key_fingerprint, null);
  assert.equal(mock().recByName(row.provider_key_name), null, 'provider key must be gone');
});

test('per-user streaming passthrough + admin-disabled model refused before any provider call', async () => {
  // Earlier tests revoked A's session (suspend → logoutAll) and narrowed
  // the routing allowlist (close-flow test) — restore both for this test.
  userA = await loginUser(stack, USER_PHONE);
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id, userF.user.id] });
  const streamRes = await fetch(`${stack.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.accessToken}` },
    body: JSON.stringify({ model: 'gpt-5.6-terra', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(streamRes.status, 200);
  assert.match(await streamRes.text(), /mock reply/);

  const { setSetting: setS } = await import('../src/settings.js');
  await setS(stack.db, 'models', [{ model: 'gpt-5.6-terra', multiplier: 1, enabled: false }]);
  try {
    const chatBefore = mock().calls.chat;
    const blocked = await chatAs(userA.accessToken, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'model_disabled');
    assert.equal(mock().calls.chat, chatBefore, 'disabled model must not reach the provider');
  } finally {
    await stack.db.query("DELETE FROM public.settings WHERE key = 'models'"); // reseed catalog defaults on next read
  }
});

test('retry_once resolution: human-confirmed re-dispatch of an ambiguous top-up (double-add is the named risk)', async () => {
  await setRouting({ mode: 'shared', allowlist: [userA.user.id, userB.user.id, userF.user.id] });
  const charge = await asOwner(`/admin-api/users/${userB.user.id}/charge`, {
    method: 'POST', body: { tokens: 30, note: 'retry once test charge' },
  });
  assert.equal(charge.status, 200, charge.text);
  mock().faults.editAmbiguous = 1;
  await worker.drainOnce();
  const intent = (await intentsFor(userB.user.id, 'topup')).at(-1);
  assert.equal(intent.state, 'needs_attention');
  const issuedBefore = Number((await keyRow(userB.user.id)).token_limit_issued);
  const resolved = await asOwner(`/admin-api/provider/intents/${intent.id}/resolve`, {
    method: 'POST', body: { decision: 'retry_once' },
  });
  assert.equal(resolved.status, 200, resolved.text);
  let fresh = null;
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    await worker.drainOnce();
    fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
    if (fresh.state === 'confirmed') break;
  }
  assert.equal(fresh.state, 'confirmed');
  assert.equal(Number((await keyRow(userB.user.id)).token_limit_issued), issuedBefore + 30);
});

test('stale in_flight lease: mutation reclaims to needs_attention, never re-executes', async () => {
  const intent = await insertIntent(stack.db, {
    userId: userB.user.id, kind: 'topup', source: 'admin_charge',
    idempotencyKey: `stale:${userB.user.id}`, amountTokens: 5, actor: 'system',
  });
  await stack.db.query(
    "UPDATE public.key_issuance_intents SET state = 'in_flight', locked_at = now() - interval '200 seconds' WHERE id = $1",
    [intent.id]);
  const editsBefore = mock().calls.edit;
  await worker.drainOnce();
  const fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
  assert.equal(fresh.state, 'needs_attention');
  assert.equal(mock().calls.edit, editsBefore, 'a reclaimed mutation must not be re-dispatched');
});

test('control-plane 403 opens the issuance circuit breaker (terminal, audited)', async () => {
  const badWorker = createWorker(stack.db, { ...stack.cfg, cvcPrimaryApiKey: 'sk-wrong-primary' });
  const intent = await insertIntent(stack.db, {
    userId: userB.user.id, kind: 'topup', source: 'admin_charge',
    idempotencyKey: `breaker:${userB.user.id}`, amountTokens: 5, actor: 'system',
  });
  await badWorker.drainOnce();
  const fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
  assert.equal(fresh.state, 'failed');
  const { breakerOpen, setBreaker } = await import('../src/reseller/routing.js');
  assert.equal(await breakerOpen(stack.db, stack.cfg), true);
  const blocked = await worker.drainOnce();
  assert.equal(blocked.blocked, 'breaker_open');
  const audits = await stack.db.many(
    "SELECT * FROM public.admin_audit WHERE action = 'provider_control_plane_auth_failed'");
  assert.ok(audits.length >= 1);
  await setBreaker(stack.db, false, {}); // owner re-enable after fixing config (§14)
  assert.equal(await breakerOpen(stack.db, stack.cfg), false);
});

test('no key material anywhere in DB attempt logs or admin audit for user A', async () => {
  const attempts = await stack.db.many(
    'SELECT attempts::text AS a FROM public.key_issuance_intents WHERE user_id = $1', [userA.user.id]);
  for (const r of attempts) assert.ok(!r.a.includes(plainA));
  const auditRows = await stack.db.many('SELECT meta::text AS m FROM public.admin_audit WHERE meta IS NOT NULL');
  for (const r of auditRows) assert.ok(!r.m.includes(plainA));
});
