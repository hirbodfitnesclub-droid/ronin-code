import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveUsage,
  isPerUserMode,
  isProviderBalanceUnavailable,
  mapRecentUsage,
  maskedKeyHint,
  BALANCE_STALE_LIMIT_MS,
} from '../src/lib/api/usage.ts';
import { MOCK_PROVIDER_KEY, MOCK_RECENT_USAGE } from '../src/lib/api/fixtures.ts';
import type { CreditsResult } from '../src/lib/api/types.ts';

test('isPerUserMode branches only on per_user (C6 guard)', () => {
  assert.equal(isPerUserMode('per_user'), true);
  assert.equal(isPerUserMode('shared'), false);
  assert.equal(isPerUserMode(undefined), false);
  assert.equal(isPerUserMode(null), false);
});

test('deriveUsage (shared mode) still aggregates ledger consume rows only', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');
  const credits: CreditsResult = {
    balanceTokens: 1000,
    spendableTokens: 1000,
    orders: [],
    ledger: [
      {
        id: '1',
        kind: 'consume',
        deltaTokens: -100,
        amountTokens: 100,
        balanceAfter: 900,
        refType: null,
        refId: null,
        note: null,
        createdAt: now.toISOString(),
        model: 'claude-sonnet',
      },
      {
        id: '2',
        kind: 'purchase',
        deltaTokens: 1000,
        amountTokens: 1000,
        balanceAfter: 1000,
        refType: null,
        refId: null,
        note: null,
        createdAt: now.toISOString(),
      },
    ],
  };
  const s = deriveUsage(credits, now);
  assert.equal(s.todayTokens, 100);
  assert.equal(s.monthTokens, 100);
  assert.equal(s.topModels[0]?.model, 'claude-sonnet');
});

test('provider balance: fresh/stale-within-24h displayable, stale beyond 24h unavailable (§7.1)', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');
  assert.equal(
    isProviderBalanceUnavailable(
      {
        status: 'active',
        tokenLimitIssued: 1,
        balanceStale: false,
        balanceObservedAt: new Date(now.getTime() - BALANCE_STALE_LIMIT_MS * 2).toISOString(),
      },
      now,
    ),
    false,
  );
  assert.equal(
    isProviderBalanceUnavailable(
      {
        status: 'active',
        tokenLimitIssued: 1,
        balanceStale: true,
        balanceObservedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      },
      now,
    ),
    false,
  );
  assert.equal(
    isProviderBalanceUnavailable(
      {
        status: 'active',
        tokenLimitIssued: 1,
        balanceStale: true,
        balanceObservedAt: new Date(now.getTime() - BALANCE_STALE_LIMIT_MS - 1).toISOString(),
      },
      now,
    ),
    true,
  );
  assert.equal(isProviderBalanceUnavailable(null, now), false);
  assert.equal(isProviderBalanceUnavailable(undefined, now), false);
});

test('mapRecentUsage caps at the provider 30-row reality and normalises rows (§7.2)', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({
    model: 'gpt-5-codex',
    inputTokens: i,
    outputTokens: 1,
    cachedTokens: 0,
    costTokens: 10,
    fast: i === 0,
    status: 'success',
    createdAt: '2026-10-23T10:00:00.000Z',
  }));
  const mapped = mapRecentUsage({ rows, totalRequests: 128, windowNote: 'recent_30' });
  assert.equal(mapped.rows.length, 30);
  assert.equal(mapped.totalRequests, 128);
  assert.equal(mapped.windowNote, 'recent_30');
  assert.equal(mapped.rows[0]?.fast, true);
});

test('mapRecentUsage tolerates malformed payloads', () => {
  assert.deepEqual(mapRecentUsage(null), { rows: [], totalRequests: 0, windowNote: 'recent_30' });
  const m = mapRecentUsage({ rows: [{ model: 42 }, { model: 'x', createdAt: '2026-10-23T10:00:00.000Z' }] });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0]?.costTokens, 0);
});

test('maskedKeyHint shows only last-4, never a full key', () => {
  assert.equal(maskedKeyHint('9f3k'), '•••• 9f3k');
  assert.equal(maskedKeyHint('…9f3k'), '•••• 9f3k');
  assert.equal(maskedKeyHint(null), null);
  assert.equal(maskedKeyHint(''), null);
});

test('mock fixtures use a fake key hint only (no real key material)', () => {
  assert.equal(MOCK_PROVIDER_KEY.keyLast4, '9f3k');
  assert.equal(MOCK_PROVIDER_KEY.status, 'active');
  assert.ok(MOCK_RECENT_USAGE.rows.length <= 30);
  assert.equal(MOCK_RECENT_USAGE.windowNote, 'recent_30');
});
