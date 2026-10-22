import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser, grant } from './helpers.mjs';

let stack, user;
const MODEL = 'gpt-5.6-luna'; // catalog model with coeff 0.5 in the default (catalog-seeded) table
// Fake upstream usage: 100 prompt + 50 completion → cost = ceil(150 × 0.5) = 75

before(async () => {
  stack = await startStack();
  user = await loginUser(stack);
  await grant(stack, user.user.id, 1000);
});
after(() => stack.close());

const chat = (token, body, headers) => req(stack.base, '/v1/chat/completions', { method: 'POST', token, body, headers });

test('metered call: settles from upstream usage, upstream key is used server-side only', async () => {
  const callsBefore = stack.upstream.state.calls;
  const r = await chat(user.accessToken, {
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: 'hello ronin' }],
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.choices);
  assert.equal(stack.upstream.state.calls, callsBefore + 1);
  assert.equal(stack.upstream.state.lastAuth, 'Bearer upstream-test-key'); // server-side key, never the user's token

  const credits = await req(stack.base, '/api/credits', { token: user.accessToken });
  assert.equal(credits.json.balanceTokens, 1000 - 75);
  assert.ok(credits.json.ledger.some((l) => l.kind === 'consume' && l.deltaTokens === -75));
});

test('idempotency: replayed completion returns the stored response and never double-charges', async () => {
  const key = 'idem-abc-123';
  const body = { model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: 'same request' }] };
  const callsBefore = stack.upstream.state.calls;
  const first = await chat(user.accessToken, body, { 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  const second = await chat(user.accessToken, body, { 'Idempotency-Key': key });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, first.json);
  assert.equal(stack.upstream.state.calls, callsBefore + 1); // upstream hit exactly once
  const credits = await req(stack.base, '/api/credits', { token: user.accessToken });
  assert.equal(credits.json.balanceTokens, 1000 - 75 - 75); // two distinct metered calls total, not three
});

test('upstream failure releases the hold — no charge', async () => {
  const before = await req(stack.base, '/api/credits', { token: user.accessToken });
  stack.upstream.state.failNext = true;
  const r = await chat(user.accessToken, { model: MODEL, messages: [{ role: 'user', content: 'boom' }] });
  assert.equal(r.status, 500);
  const afterRes = await req(stack.base, '/api/credits', { token: user.accessToken });
  assert.equal(afterRes.json.balanceTokens, before.json.balanceTokens);
  assert.equal(afterRes.json.spendableTokens, afterRes.json.balanceTokens); // nothing left reserved
});

test('insufficient credit → 402 before any upstream call', async () => {
  const poor = await loginUser(stack, '09120000111');
  const callsBefore = stack.upstream.state.calls;
  const r = await chat(poor.accessToken, { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, 'insufficient_credit');
  assert.equal(stack.upstream.state.calls, callsBefore);
});

test('concurrent reserves can never overdraw the balance', async () => {
  const rich = await loginUser(stack, '09120000222');
  await grant(stack, rich.user.id, 25_000);
  // Slow the upstream down so all 10 reservations genuinely overlap in time:
  // each reserves ~10,001 tokens (max_tokens 10000, unknown model → multiplier 1),
  // so at most floor(25000/10001) = 2 holds can be active at once.
  stack.upstream.state.delayMs = 400;
  let results;
  try {
    results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      chat(rich.accessToken, {
        model: 'unknown-model-x', max_tokens: 10_000,
        messages: [{ role: 'user', content: `race ${i}` }],
      }, { 'Idempotency-Key': `race-${i}` })));
  } finally {
    stack.upstream.state.delayMs = 0;
  }
  const okCount = results.filter((r) => r.status === 200).length;
  const rejected = results.filter((r) => r.status === 402).length;
  assert.equal(okCount, 2, `expected exactly 2 overlapping successes, got ${okCount}`);
  assert.equal(rejected, 8);
  const credits = await req(stack.base, '/api/credits', { token: rich.accessToken });
  assert.ok(credits.json.balanceTokens >= 0, 'balance went negative');
  // Each success settles ceil((100+50) × 1) = 150 with the unknown-model default multiplier 1.
  assert.equal(credits.json.balanceTokens, 25_000 - okCount * 150);
  assert.equal(credits.json.spendableTokens, credits.json.balanceTokens); // no dangling holds
});

test('fast multiplier: header and body flags charge fastMultiplier; body flag never reaches upstream', async () => {
  const { getModels, setSetting } = await import('../src/settings.js');
  const models = await getModels(stack.db, stack.cfg);
  await setSetting(stack.db, 'models', [
    ...models,
    { model: 'test-fast', multiplier: 2, fastMultiplier: 5, enabled: true },
  ]);
  await grant(stack, user.user.id, 5000);
  const balance = async () => (await req(stack.base, '/api/credits', { token: user.accessToken })).json.balanceTokens;
  const body = { model: 'test-fast', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] };
  // Fake upstream usage is 150 tokens total: ×2 = 300, ×5 (fast) = 750.

  let before = await balance();
  let r = await chat(user.accessToken, body);
  assert.equal(r.status, 200);
  assert.equal(before - (await balance()), 300, 'no flag → base multiplier');

  before = await balance();
  r = await chat(user.accessToken, body, { 'x-ronin-fast': '1' });
  assert.equal(r.status, 200);
  assert.equal(before - (await balance()), 750, 'header flag → fastMultiplier');

  before = await balance();
  r = await chat(user.accessToken, { ...body, ronin_fast: true });
  assert.equal(r.status, 200);
  assert.equal(before - (await balance()), 750, 'body flag → fastMultiplier');
  assert.equal(stack.upstream.state.lastBody.ronin_fast, undefined, 'ronin_fast must be stripped before forwarding');
  assert.equal(stack.upstream.state.lastBody.model, 'test-fast');
});

test('unauthenticated completion is rejected', async () => {
  const r = await req(stack.base, '/v1/chat/completions', { method: 'POST', body: { model: MODEL, messages: [] } });
  assert.equal(r.status, 401);
});
