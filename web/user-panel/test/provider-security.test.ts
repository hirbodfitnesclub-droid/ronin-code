import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_KEY_PATTERN,
  buildProviderKeySummaryView,
  mapRecentUsage,
  redactKeyMaterial,
} from '../src/lib/api/usage.ts';
import { claimReasonText, issuanceNoteKey } from '../src/features/purchases/claimDisplay.ts';
import { saveSession, loadSession } from '../src/lib/api/session.ts';
import { LiveApiClient } from '../src/lib/api/live.ts';
import { en } from '../src/lib/i18n/en.ts';
import type { Claim, ProviderKeySummary } from '../src/lib/api/types.ts';

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

/* ── Category 1: masked-key rendering ─────────────────────────────────── */

test('cat1: dashboard key view masks even a FULL key smuggled into keyLast4', () => {
  const pk: ProviderKeySummary = {
    status: 'active',
    tokenLimitIssued: 50_000_000,
    keyLast4: FAKE_FULL_KEY, // negative case: API misbehaves, returns full key
  };
  const view = buildProviderKeySummaryView(pk);
  assert.equal(view?.hint, '•••• 7890');
  assertNoFullKey(collectStrings(view), 'dashboard key view');
});

test('cat1: recent-usage mapping redacts a full key smuggled into model/status', () => {
  const mapped = mapRecentUsage({
    rows: [
      {
        model: FAKE_FULL_KEY,
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costTokens: 1,
        fast: false,
        status: FAKE_FULL_KEY,
        createdAt: '2026-10-23T10:00:00.000Z',
      },
    ],
    totalRequests: 1,
    windowNote: 'recent_30',
  });
  assertNoFullKey(collectStrings(mapped), 'recent usage');
  assert.match(mapped.rows[0]!.model, /•••• 7890/);
});

test('cat1: claim rejection reason redacts an embedded full key', () => {
  const claim = {
    status: 'rejected',
    adminNote: `receipt mentions ${FAKE_FULL_KEY} — rejected`,
    rejectReason: null,
    issuanceState: null,
  } as unknown as Claim;
  const text = claimReasonText(claim, 'generic');
  assertNoFullKey([text], 'claim reason');
  assert.match(text, /•••• 7890/);
});

test('cat1: no full-key pattern anywhere in panel src or fixtures', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx|css)$/.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (new RegExp(FULL_KEY_PATTERN.source).test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('cat1: components render key data only via the masking view builder (source discipline)', () => {
  const dash = readFileSync(join(SRC, 'features/dashboard/DashboardScreen.tsx'), 'utf8');
  assert.ok(dash.includes('buildProviderKeySummaryView'), 'dashboard must use the view builder');
  assert.ok(!dash.includes('providerKey?.keyLast4'), 'dashboard must not touch raw keyLast4');
  assert.ok(!dash.includes('providerKey.keyLast4'), 'dashboard must not touch raw keyLast4');
});

/* ── Category 2: payload hygiene ──────────────────────────────────────── */

test('cat2: session storage round-trip never persists key material; storage keys are an allowlist', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    saveSession({
      accessToken: 'a-token',
      refreshToken: 'r-token',
      deviceId: 'dev-1',
      user: {
        id: 'u1',
        phone: '09123456789',
        name: 'Test',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        onboarded: true,
        acquisitionSource: null,
        onboardingGoal: null,
      },
    });
    const stored = [...store.values()].join('\n');
    assertNoFullKey([stored], 'localStorage');
    assert.deepEqual([...store.keys()], ['ronin.panel.session']);
    assert.equal(loadSession()?.user.id, 'u1');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  // Every localStorage call site in the panel is one of the two known modules.
  const filesWithStorage = walk(SRC)
    .filter((f) => /\.(ts|tsx)$/.test(f) && readFileSync(f, 'utf8').includes('localStorage'))
    .map((f) => f.slice(SRC.length + 1))
    .sort();
  assert.deepEqual(filesWithStorage, ['lib/api/session.ts', 'lib/i18n/index.tsx']);
});

test('cat2: no API type or client exposes a full delegated key field', () => {
  const apiDir = join(SRC, 'lib/api');
  for (const file of walk(apiDir)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes('delegatedKey'), `${file} must not reference delegatedKey`);
    assert.ok(!content.includes('encryptedKey'), `${file} must not reference encryptedKey`);
  }
});

test('cat2: needs_attention purchase surface renders the safe-copy state from a mock payload', () => {
  const claim = {
    status: 'approved',
    issuanceState: 'needs_attention',
    adminNote: null,
    rejectReason: null,
  } as unknown as Claim;
  assert.equal(issuanceNoteKey(claim), 'purchases.issuanceAttention');
  assert.match(en['purchases.issuanceAttention'], /safe/i);
  const confirmed = {
    status: 'approved',
    issuanceState: 'confirmed',
    adminNote: null,
    rejectReason: null,
  } as unknown as Claim;
  assert.equal(issuanceNoteKey(confirmed), 'purchases.issuanceConfirmed');
  const pendingClaim = {
    status: 'pending',
    issuanceState: 'needs_attention',
    adminNote: null,
    rejectReason: null,
  } as unknown as Claim;
  assert.equal(issuanceNoteKey(pendingClaim), null, 'issuance notes only render for approved claims');
});

/* ── Category 3: IDOR-facing behaviour (stubbed fetch) ────────────────── */

interface StubRes {
  status: number;
  body: unknown;
}
function stubFetch(routes: Record<string, StubRes>) {
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    const path = Object.keys(routes).find((p) => String(url).includes(p));
    const r = path ? routes[path]! : { status: 404, body: { error: { code: 'not_found', message: 'nf' } } };
    return { status: r.status, ok: r.status < 300, json: async () => r.body };
  };
}
const PER_USER_STATUS = {
  userId: 'u1',
  status: 'active',
  isActive: true,
  balanceTokens: 5,
  spendableTokens: 5,
  lots: [],
  deviceAuthorized: true,
  activeDevices: 1,
  serverTime: '2026-10-23T10:00:00.000Z',
  routingMode: 'per_user',
  providerKey: { status: 'active', tokenLimitIssued: 50_000_000 },
};

test("cat3: 403 on another user's summary → ApiError surfaces, no data returned", async () => {
  stubFetch({
    '/api/account-status': { status: 200, body: PER_USER_STATUS },
    '/api/usage/summary': { status: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } },
  });
  const client = new LiveApiClient();
  await assert.rejects(client.usageSummary(), (e: unknown) => (e as { status?: number }).status === 403);
});

test("cat3: 404 on another user's recent usage → ApiError surfaces, no partial rows", async () => {
  stubFetch({
    '/api/account-status': { status: 200, body: PER_USER_STATUS },
    '/api/usage/recent': { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } },
  });
  const client = new LiveApiClient();
  await assert.rejects(client.recentUsage(), (e: unknown) => (e as { status?: number }).status === 404);
});

test('cat3: 403 on account-status → no fabricated per-user data (shared fallback, recentUsage null)', async () => {
  stubFetch({ '/api/account-status': { status: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } } });
  const client = new LiveApiClient();
  assert.equal(await client.recentUsage(), null, 'must not fabricate recent usage on auth failure');
});

test('cat3: redactKeyMaterial is a no-op on ordinary text', () => {
  assert.equal(redactKeyMaterial('مدل claude-sonnet — مصرف عادی'), 'مدل claude-sonnet — مصرف عادی');
  assert.equal(redactKeyMaterial(null), '');
});
