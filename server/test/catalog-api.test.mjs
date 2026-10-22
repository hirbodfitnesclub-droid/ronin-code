import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser } from './helpers.mjs';

// Pricing/catalog API surface (Scope A): packs expose FINAL prices only —
// the per-pack `usd` value (and with it the exchange rate) never leaves the
// server — and /api/models merges settings entries with catalog metadata.
let stack, user;

before(async () => {
  stack = await startStack(); // tests override tokensPerUsd = 1000
  user = await loginUser(stack);
});
after(() => stack.close());

function allKeys(value, acc = []) {
  if (Array.isArray(value)) for (const v of value) allKeys(v, acc);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { acc.push(k); allKeys(v, acc); }
  }
  return acc;
}

test('/api/packs: exactly the 4 launch packs, tokens derived from tokensPerUsd, no usd anywhere', async () => {
  const r = await req(stack.base, '/api/packs', { token: user.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.packs.length, 4);
  assert.deepEqual(r.json.packs.map((p) => p.id), ['pack-1', 'pack-2-5', 'pack-5', 'pack-20']);
  // tokens = usd × tokensPerUsd (1000 in the test config)
  assert.deepEqual(r.json.packs.map((p) => p.tokens), [1000, 2500, 5000, 20000]);
  assert.deepEqual(r.json.packs.map((p) => p.priceRials), [2800000, 7000000, 14000000, 56000000]);
  assert.equal(r.json.packs.find((p) => p.id === 'pack-5').badge, 'پیشنهاد ما');
  assert.ok(!allKeys(r.json.packs).includes('usd'), 'usd must not appear in the user packs payload');
  assert.ok(r.json.card, 'shop card display data stays');
});

test('/api/models: all 44 catalog models merged with metadata, no price/rate keys', async () => {
  const r = await req(stack.base, '/api/models', { token: user.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.models.length, 44);
  const deepseek = r.json.models.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.ok(deepseek);
  assert.equal(deepseek.coeff, 0.1);
  assert.equal(deepseek.fastCoeff, null);
  assert.equal(deepseek.enabled, true);
  const gpt = r.json.models.find((m) => m.id === 'gpt-5.5');
  assert.ok(gpt);
  assert.equal(gpt.family, 'OpenAI');
  assert.equal(gpt.fastCoeff, 10); // GPT family carries a Fast coefficient
  const bad = allKeys(r.json).filter((k) => /price|rate|toman|rial/i.test(k));
  assert.deepEqual(bad, [], `models payload must not contain price/rate keys, found: ${bad}`);
});
