import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser, loginAdmin, postClaim } from './helpers.mjs';
import { MOCK_PRIMARY } from './mock-cvc.mjs';
import { createWorker } from '../src/reseller/worker.js';
import { createResellerClient } from '../src/reseller/client.js';
import { pollKey } from '../src/reseller/reconcile.js';
import { setSetting } from '../src/settings.js';
import { insertIntent } from '../src/reseller/intents.js';

/**
 * HARD battery (tech-lead addendum) for Phase 2 server work:
 *  1. fault injection on money paths    4. security (scan / IDOR / tamper)
 *  2. relay abuse                       5. reconciliation stress
 *  3. idempotency storm + seeded fuzz
 * Fake keys only. The real provider is never called.
 */

// ── Category 4(a) capture: EVERY console line + EVERY API response in this
// file is recorded and scanned at the end for primary/delegated key values.
const captured = { logs: [], responses: [] };
for (const lvl of ['log', 'warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...args) => { captured.logs.push(args.map(String).join(' ')); orig(...args); };
}
async function R(base, path, opts = {}, tag = null) {
  const r = await req(base, path, opts);
  captured.responses.push({ path, status: r.status, text: r.text, tag });
  return r;
}
async function claim(base, token, packId) {
  const r = await postClaim(base, token, packId);
  captured.responses.push({ path: '/api/orders', status: r.status, text: r.text, tag: null });
  return r;
}

let stack, owner, worker;
const mock = () => stack.mockCvc.state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asOwner = (p, opts = {}) => R(stack.adminBase, p, { cookie: owner.cookie, csrf: owner.csrf, ...opts });
const keyRow = (userId) => stack.db.one('SELECT * FROM public.user_provider_keys WHERE user_id = $1', [userId]);
const intentsFor = (userId, kind = null) => kind
  ? stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 AND kind = $2 ORDER BY id', [userId, kind])
  : stack.db.many('SELECT * FROM public.key_issuance_intents WHERE user_id = $1 ORDER BY id', [userId]);
const allow = async (...users) => setSetting(stack.db, 'subscription_routing',
  { mode: 'shared', allowlist: users.map((u) => u.user.id) });

async function approveFor(user) {
  const created = await claim(stack.base, user.accessToken, 'pack-1');
  assert.equal(created.status, 201, created.text);
  const reviewed = await asOwner(`/admin-api/orders/${created.json.order.id}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(reviewed.status, 200, reviewed.text);
  return { orderId: created.json.order.id, reviewed: reviewed.json };
}
async function provisionedUser(phone) {
  const user = await loginUser(stack, phone);
  await allow(user); // staged allowlist: only this user for the setup purchase
  await approveFor(user);
  await worker.drainOnce();
  const row = await keyRow(user.user.id);
  assert.equal(row?.status, 'active', `provision ${phone}`);
  return { user, row, plain: mock().byName(row.provider_key_name) };
}
const chat = (token, body, headers) => R(stack.base, '/v1/chat/completions', { method: 'POST', token, body, headers });

before(async () => {
  stack = await startStack({ mockCvc: true });
  owner = await loginAdmin(stack);
  worker = createWorker(stack.db, stack.cfg);
});
after(() => stack.close());

// ═══════════ 1. Fault injection, money paths ═══════════════════════════════

test('1a. ambiguous create with response DROPPED → needs_attention, zero usable keys; replacement → exactly one', async () => {
  const user = await loginUser(stack, '09128000001');
  await allow(user);
  await approveFor(user);
  mock().faults.createDrop = 1; // provider commits, response never arrives
  await worker.drainOnce();
  const intent = (await intentsFor(user.user.id, 'create'))[0];
  assert.equal(intent.state, 'needs_attention');
  let row = await keyRow(user.user.id);
  assert.equal(row.encrypted_key, null, 'zero usable keys in our store');
  const usable = await stack.db.many(
    'SELECT id FROM public.user_provider_keys WHERE user_id = $1 AND encrypted_key IS NOT NULL', [user.user.id]);
  assert.equal(usable.length, 0);
  await worker.drainOnce(); // never auto-retried
  assert.equal((await intentsFor(user.user.id, 'create')).filter((i) => i.state === 'confirmed').length, 0);

  const resolved = await asOwner(`/admin-api/provider/intents/${intent.id}/resolve`, {
    method: 'POST', body: { decision: 'create_replacement' },
  });
  assert.equal(resolved.status, 200, resolved.text);
  await worker.drainOnce();
  row = await keyRow(user.user.id);
  assert.equal(row.status, 'active');
  const usableAfter = await stack.db.many(
    'SELECT id FROM public.user_provider_keys WHERE user_id = $1 AND encrypted_key IS NOT NULL', [user.user.id]);
  assert.equal(usableAfter.length, 1, 'exactly one usable key after resolution — never two');
});

test('1b. ambiguous top-up → provider allowance moved AT MOST once; no silent double', async () => {
  const { user, row, plain } = await provisionedUser('09128000002');
  void row; void plain;
  const charge = await asOwner(`/admin-api/users/${user.user.id}/charge`, {
    method: 'POST', body: { tokens: 250, note: 'hard battery topup' },
  });
  assert.equal(charge.status, 200, charge.text);
  const rec = mock().recByName((await keyRow(user.user.id)).provider_key_name);
  const limitBefore = rec.token_limit;
  mock().faults.editAmbiguous = 1;
  await worker.drainOnce();
  await worker.drainOnce();
  assert.equal(rec.token_limit, limitBefore + 250, 'provider side moved exactly once');
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 1000,
    'our bookkeeping does NOT silently follow an unconfirmed op');
  const intent = (await intentsFor(user.user.id, 'topup')).at(-1);
  assert.equal(intent.state, 'needs_attention');
});

test('1c. provider 500 mid-issuance (create) → ambiguous classification, needs_attention, no phantom key', async () => {
  const user = await loginUser(stack, '09128000003');
  await allow(user);
  await approveFor(user);
  mock().faults.create500 = 1;
  await worker.drainOnce();
  const intent = (await intentsFor(user.user.id, 'create'))[0];
  assert.equal(intent.state, 'needs_attention');
  assert.equal(intent.provider_http_status, 500);
  const row = await keyRow(user.user.id);
  assert.equal(row.encrypted_key, null);
  assert.equal(mock().recByName(row.provider_key_name), null, 'mock committed nothing on a pre-commit 500');
});

test('1c2. provider 503 on balance reads → reads retry, reconcile poll completes, NO drift flag on stale data', async () => {
  const { user, plain } = await provisionedUser('09128000013');
  const client = createResellerClient(stack.cfg);
  mock().faults.balance503 = 2; // two 503s, third read succeeds (bounded read retry)
  const bal = await client.getBalance(plain);
  assert.equal(typeof bal, 'number');
  mock().faults.balance503 = 30; // now reads genuinely fail
  const freshRow = await keyRow(user.user.id);
  const out = await pollKey(stack.db, stack.cfg, client, freshRow);
  assert.equal(out.polled, true, 'poll completes despite balance outage');
  const flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift'", [user.user.id]);
  assert.equal(flags.length, 0, 'no drift decisions from stale/unavailable data');
});

test('1d. provider 409 on unlimited-key top-up → terminal failed, no retry, bookkeeping unchanged', async () => {
  const { user } = await provisionedUser('09128000004');
  const row = await keyRow(user.user.id);
  mock().recByName(row.provider_key_name).token_limit = null; // provider-side: key became unlimited
  const intent = await insertIntent(stack.db, {
    userId: user.user.id, kind: 'topup', source: 'admin_charge',
    idempotencyKey: `hard-409:${user.user.id}`, amountTokens: 100, actor: 'system',
  });
  const editsBefore = mock().calls.edit;
  await worker.drainOnce();
  await sleep(50);
  await worker.drainOnce();
  const fresh = await stack.db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
  assert.equal(fresh.state, 'failed');
  assert.equal(fresh.provider_error_code, 'unlimited_cannot_topup');
  assert.equal(mock().calls.edit, editsBefore + 1, 'a 409 is terminal — exactly one dispatch');
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 1000);
});

test('1e. freeze intent then top-up intent → safe execution order, correct final state', async () => {
  const { user } = await provisionedUser('09128000005');
  const row = await keyRow(user.user.id);
  const editsBefore = mock().editLog.length;
  await insertIntent(stack.db, {
    userId: user.user.id, kind: 'freeze', source: 'suspend',
    idempotencyKey: `hard-ord-freeze:${user.user.id}`, actor: 'admin:test',
  });
  await insertIntent(stack.db, {
    userId: user.user.id, kind: 'topup', source: 'admin_charge',
    idempotencyKey: `hard-ord-topup:${user.user.id}`, amountTokens: 400, actor: 'admin:test',
  });
  await worker.drainOnce();
  const edits = mock().editLog.slice(editsBefore).filter((e) => e.name === row.provider_key_name);
  const freezeIdx = edits.findIndex((e) => e.fields.includes('active'));
  const topupIdx = edits.findIndex((e) => e.fields.includes('additional_tokens'));
  assert.ok(freezeIdx >= 0 && topupIdx >= 0 && freezeIdx < topupIdx,
    `freeze must execute before/with priority over the top-up, got ${JSON.stringify(edits)}`);
  const fresh = await keyRow(user.user.id);
  assert.equal(fresh.status, 'frozen', 'final state stays frozen');
  assert.equal(Number(fresh.token_limit_issued), 1400, 'top-up still landed on the frozen key');
  assert.equal(mock().recByName(row.provider_key_name).is_active, false);
  assert.equal(mock().recByName(row.provider_key_name).token_limit, 1400);
  assert.ok((await intentsFor(user.user.id)).every((i) => ['confirmed', 'superseded'].includes(i.state)));
});

// ═══════════ 2. Relay abuse ════════════════════════════════════════════════

test('2a. provider 402 at stream start → credit-exhausted envelope; ZERO charge state exists on our side', async () => {
  const { user } = await provisionedUser('09128000006');
  mock().faults.chatStream402 = 1;
  const r = await chat(user.accessToken, {
    model: 'gpt-5.6-terra', stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'insufficient_credit');
  const holds = await stack.db.many('SELECT id FROM public.holds WHERE user_id = $1', [user.user.id]);
  assert.equal(holds.length, 0, 'per-user mode must hold no charge state at all');
  const chargeRows = await stack.db.many(
    "SELECT id FROM public.ledger WHERE user_id = $1 AND kind IN ('hold','consume','release')", [user.user.id]);
  assert.equal(chargeRows.length, 0, 'no hold/consume/release ledger rows may exist for a per-user user');
});

test('2b. provider hangs then closes early → clean 502 upstream error, no hung socket', async () => {
  const { user } = await provisionedUser('09128000007');
  mock().faults.chatHangClose = 1;
  const started = Date.now();
  const r = await chat(user.accessToken, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'upstream_unreachable');
  assert.ok(elapsed < 5000, `relay must not hang (took ${elapsed}ms)`);
  const health = await R(stack.base, '/healthz');
  assert.equal(health.status, 200, 'server stays healthy after an upstream hang/close');
});

test('2c. key frozen WHILE a stream is in flight → in-flight completes; next request blocked cleanly', async () => {
  const { user, plain } = await provisionedUser('09128000008');
  await allow(user);
  mock().slowStream = true;
  try {
    const resPromise = fetch(`${stack.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
      body: JSON.stringify({ model: 'gpt-5.6-terra', stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
    });
    await sleep(150); // stream is in flight (chunks at ~0/350/700ms)
    const freeze = await asOwner(`/admin-api/users/${user.user.id}/provider-key/freeze`, { method: 'POST', body: {} });
    assert.equal(freeze.status, 200, freeze.text);
    await worker.drainOnce(); // provider-side freeze lands mid-stream
    assert.equal((await keyRow(user.user.id)).status, 'frozen');
    const res = await resPromise;
    assert.equal(res.status, 200, 'an already-dispatched stream is not torn down by a freeze');
    const text = await res.text();
    captured.responses.push({ path: '/v1/chat/completions', status: 200, text, tag: null });
    assert.match(text, /mock reply/);
  } finally {
    mock().slowStream = false;
  }
  const blocked = await chat(plain, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'again' }] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'account_suspended');
});

test('2d. two devices of the same user streaming concurrently on one key → both served, provider accounts both', async () => {
  const phone = '09128000009';
  const dev1 = await loginUser(stack, phone);
  const dev2 = await loginUser(stack, phone); // second device (cap = 2)
  const user = { accessToken: dev1.accessToken, user: dev1.user };
  await allow(user);
  await approveFor(user);
  await worker.drainOnce();
  const row = await keyRow(user.user.id);
  const plain = mock().byName(row.provider_key_name);
  const logsBefore = mock().recByName(row.provider_key_name).logs.length;
  const [c1, c2] = await Promise.all([
    R(stack.base, '/api/subscription/credential', { token: dev1.accessToken }, user.user.id),
    R(stack.base, '/api/subscription/credential', { token: dev2.accessToken }, user.user.id),
  ]);
  assert.equal(c1.json.delegatedKey, plain);
  assert.equal(c2.json.delegatedKey, plain, 'both devices resolve the same single key — no race');
  const authsBefore = mock().chatAuths.length;
  const [s1, s2] = await Promise.all([
    chat(dev1.accessToken, { model: 'gpt-5.6-terra', stream: true, messages: [{ role: 'user', content: 'a' }] }),
    chat(dev2.accessToken, { model: 'gpt-5.6-terra', stream: true, messages: [{ role: 'user', content: 'b' }] }),
  ]);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  assert.equal(mock().chatAuths.length, authsBefore + 2);
  assert.ok(mock().chatAuths.slice(-2).every((a) => a === `Bearer ${plain}`));
  assert.equal(mock().recByName(row.provider_key_name).logs.length, logsBefore + 2,
    'provider-side accounting counts both streams');
});

// ═══════════ 3. Idempotency storm + fuzz ═══════════════════════════════════

test('3a. duplicate claim-approval (parallel double review) → single issuance', async () => {
  const user = await loginUser(stack, '09128000010');
  await allow(user);
  const created = await claim(stack.base, user.accessToken, 'pack-1');
  const orderId = created.json.order.id;
  const [r1, r2] = await Promise.all([
    asOwner(`/admin-api/orders/${orderId}/review`, { method: 'POST', body: { action: 'approve' } }),
    asOwner(`/admin-api/orders/${orderId}/review`, { method: 'POST', body: { action: 'approve' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `exactly one approval wins: ${statuses}`);
  const createsBefore = mock().createNames.filter((n) => n.startsWith(`ronin-${user.user.id.slice(0, 8)}`)).length;
  await worker.drainOnce();
  const createsAfter = mock().createNames.filter((n) => n.startsWith(`ronin-${user.user.id.slice(0, 8)}`)).length;
  assert.equal(createsAfter - createsBefore, 1, 'exactly one provider key created');
  assert.equal((await intentsFor(user.user.id, 'create')).length, 1);
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 1000);
});

test('3b. approval + backfill sweeper racing → single intent per purchase', async () => {
  const user = await loginUser(stack, '09128000011');
  await allow(user);
  const { orderId } = await approveFor(user); // inline intent already inserted
  const w2 = createWorker(stack.db, stack.cfg);
  await Promise.all([worker.sweepBackfill(), w2.sweepBackfill(), worker.sweepBackfill()]);
  const forOrder = await stack.db.many(
    'SELECT * FROM public.key_issuance_intents WHERE idempotency_key = $1', [`claim-issuance:${orderId}`]);
  assert.equal(forOrder.length, 1, 'sweeper anti-join + unique idempotency key = one intent');
  await worker.drainOnce();
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 1000);
});

test('3c. concurrent workers draining concurrent top-ups → final allowance == exact sum', async () => {
  const { user } = await provisionedUser('09128000012');
  await allow(user);
  for (let i = 0; i < 5; i++) {
    const c = await asOwner(`/admin-api/users/${user.user.id}/charge`, {
      method: 'POST', body: { tokens: 100, note: `storm topup ${i}` },
    });
    assert.equal(c.status, 200, c.text);
  }
  const w2 = createWorker(stack.db, stack.cfg);
  const w3 = createWorker(stack.db, stack.cfg);
  await Promise.all([worker.drainOnce(), w2.drainOnce(), w3.drainOnce()]);
  await worker.drainOnce();
  const row = await keyRow(user.user.id);
  assert.equal(Number(row.token_limit_issued), 1500);
  assert.equal(mock().recByName(row.provider_key_name).token_limit, 1500,
    'provider allowance == exact sum, no double-processing under SKIP LOCKED contention');
  const topups = await intentsFor(user.user.id, 'topup');
  assert.equal(topups.length, 5);
  assert.ok(topups.every((t) => t.state === 'confirmed'));
});

// Deterministic PRNG (mulberry32) — the fuzz sequence is reproducible from the seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('3d. seeded fuzz over the intent state machine → invariant total_issued == total_approved per user, always', async () => {
  const rnd = mulberry32(20261023);
  const phones = ['09128000020', '09128000021', '09128000022'];
  const subjects = [];
  for (const phone of phones) {
    const s = await provisionedUser(phone); // clean initial create, 1000 approved
    subjects.push({ ...s, ops: [] });
  }
  await allow(...subjects.map((s) => s.user));
  // Generate each user's op sequence from the seeded PRNG.
  for (const s of subjects) {
    for (let i = 0; i < 18; i++) {
      const r = rnd();
      if (r < 0.34) s.ops.push({ t: 'purchase' });
      else if (r < 0.62) s.ops.push({ t: 'charge', amt: 50 + Math.floor(rnd() * 250) });
      else if (r < 0.74) s.ops.push({ t: 'charge', amt: -(30 + Math.floor(rnd() * 120)) });
      else if (r < 0.87) s.ops.push({ t: 'freeze' });
      else s.ops.push({ t: 'unfreeze' });
    }
  }
  const maybeFault = () => {
    const r = rnd();
    if (r < 0.22) mock().faults.editAmbiguous += 1;
    else if (r < 0.27) mock().faults.editAmbiguous += 2;
  };
  // Resolve a user's stuck intents IMMEDIATELY (one stuck op per user at a
  // time → the mock-vs-bookkeeping diff is decisive evidence, exactly the
  // §3.5 admin situation). Resolving several stuck additive ops later, after
  // absolute reduces interleave, is not mechanically decidable — by design
  // that case belongs to a human reading per-intent snapshots.
  async function resolveStuckFor(userId) {
    for (let i = 0; i < 10; i++) {
      const stuck = await stack.db.many(
        "SELECT * FROM public.key_issuance_intents WHERE user_id = $1 AND state = 'needs_attention' ORDER BY id LIMIT 1",
        [userId]);
      if (!stuck.length) return;
      const intent = stuck[0];
      const row = await keyRow(userId);
      const dbIssued = Number(row?.token_limit_issued ?? 0);
      const mockLimit = row ? (mock().recByName(row.provider_key_name)?.token_limit ?? null) : null;
      let decision;
      if (intent.kind === 'create' || (intent.kind === 'convert' && !row?.encrypted_key)) decision = 'create_replacement';
      else if (intent.kind === 'topup' || intent.kind === 'convert') {
        const diff = mockLimit === null ? 0 : mockLimit - dbIssued;
        assert.ok(diff === Number(intent.amount_tokens) || diff === 0,
          `single-stuck-op oracle: diff ${diff} must be the amount ${intent.amount_tokens} (committed) or 0 (not landed)`);
        decision = diff === Number(intent.amount_tokens) ? 'mark_applied' : 'retry_once';
      } else if (intent.kind === 'reduce') {
        decision = (mockLimit !== null && mockLimit === Number(intent.target_token_limit)) ? 'mark_applied' : 'retry_once';
      } else decision = 'retry_once'; // freeze/unfreeze/delete: idempotent
      const res = await asOwner(`/admin-api/provider/intents/${intent.id}/resolve`, {
        method: 'POST', body: { decision },
      });
      assert.equal(res.status, 200, `resolve ${intent.id} (${intent.kind}) via ${decision}: ${res.text}`);
      await sleep(30);
      await worker.drainOnce();
    }
  }
  // Execute round-robin, faults injected per the same seeded stream.
  for (let step = 0; step < 18; step++) {
    for (const s of subjects) {
      const op = s.ops[step];
      if (!op) continue;
      if (op.t === 'purchase') await approveFor(s.user);
      else if (op.t === 'charge') {
        if (op.amt < 0) {
          const bal = await stack.db.one('SELECT public.ledger_balance($1) AS b', [s.user.user.id]);
          if (Number(bal.b) + op.amt < 200) continue; // keep debits safely funded
        }
        const c = await asOwner(`/admin-api/users/${s.user.user.id}/charge`, {
          method: 'POST', body: { tokens: op.amt, note: `fuzz charge step ${step}` },
        });
        assert.equal(c.status, 200, c.text);
      } else {
        const c = await asOwner(`/admin-api/users/${s.user.user.id}/provider-key/${op.t}`, { method: 'POST', body: {} });
        assert.equal(c.status, 200, c.text);
      }
      maybeFault();
      await worker.drainOnce();
      await resolveStuckFor(s.user.user.id);
    }
  }
  // Quiesce: immediate resolution above should have left nothing stuck;
  // drain any safe-retry stragglers and assert the machine is fully at rest
  // FOR THE FUZZ SUBJECTS (earlier tests in this file deliberately leave
  // some needs_attention intents unresolved — they are not the fuzz's).
  const subjectIds = subjects.map((s) => s.user.user.id);
  for (let round = 0; round < 60; round++) {
    await worker.drainOnce();
    for (const s of subjects) await resolveStuckFor(s.user.user.id);
    const live = await stack.db.one(
      "SELECT count(*)::int AS c FROM public.key_issuance_intents WHERE user_id = ANY($1) AND state IN ('pending','in_flight','needs_attention')",
      [subjectIds]);
    if (live.c === 0) break;
    await sleep(30);
  }
  const stillLive = await stack.db.one(
    "SELECT count(*)::int AS c FROM public.key_issuance_intents WHERE user_id = ANY($1) AND state IN ('pending','in_flight','needs_attention')",
    [subjectIds]);
  assert.equal(stillLive.c, 0, 'fuzz must quiesce');
  // THE INVARIANT: per user, provider allowance == our bookkeeping == net approved money.
  for (const s of subjects) {
    const net = await stack.db.one(
      `SELECT COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger
       WHERE user_id = $1 AND kind IN ('purchase','adjust')`, [s.user.user.id]);
    const row = await keyRow(s.user.user.id);
    const mockLimit = mock().recByName(row.provider_key_name).token_limit;
    assert.equal(Number(row.token_limit_issued), Number(net.s),
      `issued != approved for ${s.user.user.id}: issued=${row.token_limit_issued} approved=${net.s}`);
    assert.equal(mockLimit, Number(net.s),
      `provider != approved for ${s.user.user.id}: provider=${mockLimit} approved=${net.s}`);
  }
});

// ═══════════ 4. Security ═══════════════════════════════════════════════════

let secA, secB;
test('4b. IDOR: user A can never reach user B\'s key/balance/logs/credential; user tokens are not admin tokens', async () => {
  secA = await provisionedUser('09128000030');
  secB = await provisionedUser('09128000031');
  await allow(secA.user, secB.user);
  mock().addLog(secB.plain, { cost_tokens: 111, model: 'model-b-only' });
  mock().addLog(secB.plain, { cost_tokens: 112, model: 'model-b-only' });
  mock().addLog(secB.plain, { cost_tokens: 113, model: 'model-b-only' });

  const credA = await R(stack.base, '/api/subscription/credential', { token: secA.user.accessToken }, secA.user.user.id);
  assert.equal(credA.json.delegatedKey, secA.plain);
  assert.notEqual(credA.json.delegatedKey, secB.plain);
  // Query-string userId spoof attempt is ignored.
  const spoof = await R(stack.base, `/api/subscription/credential?userId=${secB.user.user.id}`,
    { token: secA.user.accessToken }, secA.user.user.id);
  assert.equal(spoof.json.delegatedKey, secA.plain);
  // Path-style IDOR attempt: no such route.
  const pathIdor = await R(stack.base, `/api/subscription/credential/${secB.user.user.id}`, { token: secA.user.accessToken });
  assert.equal(pathIdor.status, 404);

  const recentA = await R(stack.base, '/api/usage/recent', { token: secA.user.accessToken });
  const recA = mock().recByName(secA.row.provider_key_name);
  assert.equal(recentA.json.totalRequests, recA.logs.length, 'A sees exactly A\'s log total');
  assert.ok(recentA.json.rows.every((r) => r.model !== 'model-b-only'), 'none of B\'s rows leak into A\'s usage');

  const statusA = await R(stack.base, '/api/account-status', { token: secA.user.accessToken });
  assert.equal(statusA.json.providerKey.tokenLimitIssued, Number(secA.row.token_limit_issued));

  // User tokens against the ADMIN surface (incl. B's provider-key dossier):
  for (const p of [`/admin-api/users/${secB.user.user.id}/provider-key`, '/admin-api/provider/intents?state=needs_attention']) {
    const r = await R(stack.adminBase, p, { token: secA.user.accessToken });
    assert.ok([401, 403, 404].includes(r.status), `${p} with a user token must be rejected, got ${r.status}`);
    assert.ok(!r.text.includes(secB.plain));
  }
  // And B's token cannot fetch A's credential either (symmetry).
  const credB = await R(stack.base, '/api/subscription/credential', { token: secB.user.accessToken }, secB.user.user.id);
  assert.equal(credB.json.delegatedKey, secB.plain);
});

test('4c. key-store tamper: corrupted ciphertext → clean error, no crash, no plaintext fallback, attention raised', async () => {
  const victim = await provisionedUser('09128000032');
  const witness = await provisionedUser('09128000033');
  await allow(victim.user, witness.user);
  const row = await keyRow(victim.user.user.id);
  const corrupted = row.encrypted_key.slice(0, 20) + 'XXXX' + row.encrypted_key.slice(24);
  await stack.db.query('UPDATE public.user_provider_keys SET encrypted_key = $2 WHERE id = $1', [row.id, corrupted]);

  const cred = await R(stack.base, '/api/subscription/credential', { token: victim.user.accessToken }, victim.user.user.id);
  assert.equal(cred.status, 200, 'no crash');
  assert.equal(cred.json.keyStatus, 'needs_attention');
  assert.equal(cred.json.delegatedKey, undefined, 'no plaintext fallback of any kind');

  const chatRes = await chat(victim.user.accessToken, { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(chatRes.status, 503);
  assert.equal(chatRes.json.error.code, 'provider_key_not_ready');
  const flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_key_attention' AND status = 'open'",
    [victim.user.user.id]);
  assert.ok(flags.length >= 1, 'decrypt failure must raise the attention path (design §10 row 14)');

  const health = await R(stack.base, '/healthz');
  assert.equal(health.status, 200);
  const credW = await R(stack.base, '/api/subscription/credential', { token: witness.user.accessToken }, witness.user.user.id);
  assert.equal(credW.json.delegatedKey, witness.plain, 'other users are unaffected');
});

// ═══════════ 5. Reconciliation stress ══════════════════════════════════════

test('5. drift ahead AND behind → one bounded provider_drift flag; ledger is NEVER edited by reconciliation', async () => {
  const { user } = await provisionedUser('09128000040');
  await allow(user);
  // Raise the stakes above ε = max(100k, 1%·L): top up 200k via admin charge.
  const charge = await asOwner(`/admin-api/users/${user.user.id}/charge`, {
    method: 'POST', body: { tokens: 200_000, note: 'reconcile stress stake' },
  });
  assert.equal(charge.status, 200, charge.text);
  await worker.drainOnce();
  const row = await keyRow(user.user.id);
  assert.equal(Number(row.token_limit_issued), 201_000);
  const rec = mock().recByName(row.provider_key_name);

  const ledgerBefore = await stack.db.one(
    'SELECT count(*)::int AS c, COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE user_id = $1',
    [user.user.id]);
  await worker.reconcile(); // clean baseline poll
  let flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'", [user.user.id]);
  assert.equal(flags.length, 0, 'no drift when provider and ledger agree');

  // BEHIND: provider burned 150k that our logs never saw (balance collapses
  // with no observed usage) → under-issuance after 2 consecutive polls.
  rec.tokens_used += 150_000;
  await worker.reconcile();
  await worker.reconcile();
  flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'", [user.user.id]);
  assert.equal(flags.length, 1, 'under-issuance drift raises exactly one flag');
  assert.match(flags[0].note, /under-issuance/);

  // AHEAD: provider-side limit inflated +150k (user could spend unpurchased
  // tokens) → over-issuance direction; reporting stays bounded at one flag.
  rec.tokens_used -= 150_000;
  rec.token_limit += 150_000;
  await worker.reconcile();
  await worker.reconcile();
  await worker.reconcile();
  flags = await stack.db.many(
    "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'", [user.user.id]);
  assert.equal(flags.length, 1, 'bounded reporting: still exactly one open drift flag');

  // Reconciliation NEVER writes the ledger or our issuance bookkeeping.
  const ledgerAfter = await stack.db.one(
    'SELECT count(*)::int AS c, COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE user_id = $1',
    [user.user.id]);
  assert.deepEqual(
    { c: ledgerAfter.c, s: Number(ledgerAfter.s) },
    { c: ledgerBefore.c, s: Number(ledgerBefore.s) },
    'ledger row count and sum are untouched by reconciliation');
  assert.equal(Number((await keyRow(user.user.id)).token_limit_issued), 201_000,
    'no auto-correction of token_limit_issued either — a human resolves drift');
});

test('4a. SECRET SCAN: primary + every delegated key appear NOWHERE except the owner\'s own credential response', async () => {
  const delegated = [...mock().keys.keys()].filter((k) => k !== MOCK_PRIMARY);
  assert.ok(delegated.length >= 8, `scan must be meaningful (saw ${delegated.length} delegated keys)`);
  const keyOwner = new Map(); // plaintext → userId, via fingerprint rows
  for (const plain of delegated) {
    const { fingerprintOf } = await import('../src/reseller/crypto.js');
    const r = await stack.db.one('SELECT user_id FROM public.user_provider_keys WHERE key_fingerprint = $1',
      [fingerprintOf(plain)]);
    if (r) keyOwner.set(plain, r.user_id);
  }
  // (i) Logs: absolutely nothing, not even in credential flows.
  const allLogs = captured.logs.join('\n');
  assert.ok(!allLogs.includes(MOCK_PRIMARY), 'primary key leaked into logs');
  for (const plain of delegated) assert.ok(!allLogs.includes(plain), 'delegated key leaked into logs');
  // (ii) Responses: primary nowhere; delegated only in the owner's credential response.
  assert.ok(captured.responses.length > 60, `scan covers the suite's traffic (${captured.responses.length} responses)`);
  for (const rec of captured.responses) {
    assert.ok(!rec.text.includes(MOCK_PRIMARY), `primary key leaked in response to ${rec.path}`);
    for (const plain of delegated) {
      if (!rec.text.includes(plain)) continue;
      assert.equal(rec.path.split('?')[0], '/api/subscription/credential',
        `delegated key leaked in response to ${rec.path}`);
      assert.equal(keyOwner.get(plain), rec.tag,
        'credential response may contain ONLY the requesting owner\'s key');
    }
  }
  // (iii) DB free-text surfaces: attempt logs + audit meta carry no key material.
  const attempts = await stack.db.many('SELECT attempts::text AS a FROM public.key_issuance_intents');
  const audits = await stack.db.many('SELECT meta::text AS m FROM public.admin_audit WHERE meta IS NOT NULL');
  for (const { a } of attempts) {
    assert.ok(!a.includes(MOCK_PRIMARY));
    for (const plain of delegated) assert.ok(!a.includes(plain));
  }
  for (const { m } of audits) {
    assert.ok(!m.includes(MOCK_PRIMARY));
    for (const plain of delegated) assert.ok(!m.includes(plain));
  }
});
