import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_KEY_PATTERN,
  buildProviderKeyView,
  classifyProviderKeyError,
  redactKeyMaterial,
  riskFlagDisplay,
  type ProviderIntent,
  type ProviderKeyDetail,
} from '../src/lib/providerKey.ts';
import { api, ApiError } from '../src/lib/api.ts';

/* FAKE full key — test material only, never a real credential. */
const FAKE_FULL_KEY = 'sk-ronin-test-FAKEFULLKEYabcdef1234567890';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

function assertNoFullKey(strings: string[], where: string) {
  for (const s of strings) {
    assert.ok(!s.includes(FAKE_FULL_KEY), `${where}: full key leaked in "${s}"`);
    assert.ok(!new RegExp(FULL_KEY_PATTERN.source).test(s), `${where}: key pattern in "${s}"`);
  }
}

function intent(partial: Partial<ProviderIntent>): ProviderIntent {
  return {
    id: '1', kind: 'topup', source: 'claim', state: 'confirmed', amountTokens: 1000,
    targetTokenLimit: null, orderId: null, actor: 'system', attemptCount: 1,
    providerHttpStatus: 200, providerErrorCode: null, balanceBefore: null, usedBefore: null,
    createdAt: 1, updatedAt: 1, completedAt: 1, ...partial,
  };
}

function detail(partial: Partial<ProviderKeyDetail>): ProviderKeyDetail {
  return {
    exists: true, status: 'active', keyLast4: '9f3k', tokenLimitIssued: 50_000_000,
    tokensUsedObserved: 12_000_000, balanceObserved: 38_000_000, balanceObservedAt: 1,
    balanceStale: false, convertedAt: null, convertedTokens: null, lastReconciledAt: 1,
    openDriftFlags: 0, openAttentionFlags: 0, intents: [], attentionIntents: [], ...partial,
  };
}

/* ── Category 1: masked-key rendering ─────────────────────────────────── */

test('cat1: key section view masks a FULL key smuggled into keyLast4/actor/source/error fields', () => {
  const d = detail({
    keyLast4: FAKE_FULL_KEY, // negative case: API returns the full key here
    intents: [intent({ actor: `admin ${FAKE_FULL_KEY}`, source: FAKE_FULL_KEY })],
    attentionIntents: [
      intent({ id: '9', state: 'needs_attention', providerErrorCode: FAKE_FULL_KEY, balanceBefore: 100, usedBefore: 5 }),
    ],
  });
  const view = buildProviderKeyView(d);
  assert.equal(view.maskedKey, '•••• 7890');
  assertNoFullKey(collectStrings(view), 'provider key view');
});

test('cat1: risk view redacts a full key embedded in a flag note (provider_drift)', () => {
  const disp = riskFlagDisplay({ kind: 'provider_drift', note: `drift for ${FAKE_FULL_KEY} U+B>L`, status: 'open' });
  assert.equal(disp.warn, true);
  assert.equal(disp.isProvider, true);
  assertNoFullKey([disp.label, disp.note], 'risk flag view');
  assert.match(disp.note, /•••• 7890/);
});

test('cat1: no full-key pattern anywhere in admin src', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx|css)$/.test(file)) continue;
    if (new RegExp(FULL_KEY_PATTERN.source).test(readFileSync(file, 'utf8'))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('cat1: key section component renders only via the view builder (source discipline)', () => {
  const section = readFileSync(join(SRC, 'features/users/ProviderKeySection.tsx'), 'utf8');
  assert.ok(section.includes('buildProviderKeyView'), 'section must use the view builder');
  assert.ok(!section.includes('keyLast4'), 'section must never touch the raw keyLast4 field');
  const risk = readFileSync(join(SRC, 'features/users/UserRiskDevices.tsx'), 'utf8');
  assert.ok(risk.includes('riskFlagDisplay'), 'risk UI must render flags via the display builder');
  assert.ok(!risk.includes('f.note'), 'risk UI must not render the raw flag note');
});

/* ── Category 2: payload hygiene ──────────────────────────────────────── */

test('cat2: admin panel persists NOTHING in localStorage (cookie session discipline)', () => {
  const filesWithStorage = walk(SRC).filter(
    (f) => /\.(ts|tsx)$/.test(f) && readFileSync(f, 'utf8').includes('localStorage'),
  );
  assert.deepEqual(filesWithStorage, []);
  for (const file of walk(SRC)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes('delegatedKey'), `${file} must not reference delegatedKey`);
    assert.ok(!content.includes('encrypted_key'), `${file} must not reference encrypted_key`);
  }
});

test('cat2: needs_attention surface builds its alert state from a mock payload', () => {
  const d = detail({
    status: 'needs_attention',
    attentionIntents: [
      intent({ id: '77', kind: 'topup', state: 'needs_attention', amountTokens: 50_000_000, balanceBefore: 20_000_000, usedBefore: 1_200_000, attemptCount: 1 }),
    ],
  });
  const view = buildProviderKeyView(d);
  assert.equal(view.attention.length, 1);
  assert.deepEqual(view.attention[0]!.decisions, ['mark_applied', 'retry_once', 'abandon']);
  assert.ok(view.attention[0]!.evidence?.includes('شواهد موجودی'), 'topup evidence line must render');
  assert.equal(view.statusLabel, 'نیازمند بررسی');
});

test('cat2: provider_drift flag renders warn state; resolved drift does not', () => {
  assert.equal(riskFlagDisplay({ kind: 'provider_drift', note: 'x', status: 'open' }).warn, true);
  assert.equal(riskFlagDisplay({ kind: 'provider_drift', note: 'x', status: 'resolved' }).warn, false);
  assert.equal(riskFlagDisplay({ kind: 'provider_key_attention', note: 'x', status: 'open' }).warn, true);
});

/* ── Category 3: IDOR-facing behaviour (stubbed fetch) ────────────────── */

function stubFetch(status: number, body: unknown) {
  (globalThis as { fetch?: unknown }).fetch = async () => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

test("cat3: 403 on another user's provider-key → ApiError 403 → classified as standard error (not empty state)", async () => {
  stubFetch(403, { error: { code: 'forbidden', message: 'Forbidden' } });
  let caught: unknown = null;
  try {
    await api.providerKey('someone-else');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).status, 403);
  assert.equal(classifyProviderKeyError(caught), 'error', '403 must show the standard error state, never the no-key empty state');
});

test('cat3: 404 → classified as the legitimate not_found empty state', async () => {
  stubFetch(404, { error: { code: 'not_found', message: 'Not found' } });
  let caught: unknown = null;
  try {
    await api.providerKey('no-key-user');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError);
  assert.equal(classifyProviderKeyError(caught), 'not_found');
});

test('cat3: classifyProviderKeyError never maps auth/server failures to empty state', () => {
  assert.equal(classifyProviderKeyError(new ApiError(401, 'unauthorized', 'x')), 'error');
  assert.equal(classifyProviderKeyError(new ApiError(500, 'internal', 'x')), 'error');
  assert.equal(classifyProviderKeyError(new Error('network down')), 'error');
  assert.equal(classifyProviderKeyError(null), 'error');
  assert.equal(classifyProviderKeyError({ status: 404 }), 'not_found');
  assert.equal(classifyProviderKeyError({ code: 'not_found' }), 'not_found');
});

test('cat3: redactKeyMaterial leaves ordinary admin text untouched', () => {
  assert.equal(redactKeyMaterial('system:reconciler'), 'system:reconciler');
  assert.equal(redactKeyMaterial(null), '');
});
