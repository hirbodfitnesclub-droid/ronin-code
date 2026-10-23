import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canFreeze,
  canUnfreeze,
  isProviderRiskKind,
  maskedProviderKey,
  remainingObserved,
  resolveDecisionsFor,
  riskKindLabel,
  type ProviderIntent,
  type ProviderKeyDetail,
} from '../src/lib/providerKey.ts';

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

test('maskedProviderKey shows last-4 only', () => {
  assert.equal(maskedProviderKey('9f3k'), '•••• 9f3k');
  assert.equal(maskedProviderKey('…9f3k'), '•••• 9f3k');
  assert.equal(maskedProviderKey(null), '—');
});

test('remainingObserved never goes negative', () => {
  assert.equal(remainingObserved(detail({})), 38_000_000);
  assert.equal(remainingObserved(detail({ tokensUsedObserved: 99_000_000 })), 0);
});

test('freeze/unfreeze gating follows status and in-flight intents (§7.4)', () => {
  assert.equal(canFreeze(detail({})), true);
  assert.equal(canFreeze(detail({ status: 'frozen' })), false);
  assert.equal(canFreeze(detail({ exists: false })), false);
  assert.equal(canFreeze(detail({ intents: [intent({ kind: 'freeze', state: 'pending' })] })), false);
  assert.equal(canUnfreeze(detail({ status: 'frozen' })), true);
  assert.equal(canUnfreeze(detail({ status: 'active' })), false);
  assert.equal(canUnfreeze(detail({ status: 'frozen', intents: [intent({ kind: 'unfreeze', state: 'in_flight' })] })), false);
});

test('resolution decisions match §3.5 per intent kind', () => {
  assert.deepEqual(resolveDecisionsFor(intent({ state: 'needs_attention', kind: 'create' })), ['create_replacement', 'abandon']);
  assert.deepEqual(resolveDecisionsFor(intent({ state: 'needs_attention', kind: 'convert' })), ['create_replacement', 'abandon']);
  assert.deepEqual(resolveDecisionsFor(intent({ state: 'needs_attention', kind: 'topup' })), ['mark_applied', 'retry_once', 'abandon']);
  assert.deepEqual(resolveDecisionsFor(intent({ state: 'needs_attention', kind: 'freeze' })), ['retry_once', 'abandon']);
  assert.deepEqual(resolveDecisionsFor(intent({ state: 'confirmed', kind: 'topup' })), []);
});

test('provider drift/attention kinds get friendly labels in the risk UI (§8)', () => {
  assert.equal(isProviderRiskKind('provider_drift'), true);
  assert.equal(isProviderRiskKind('provider_key_attention'), true);
  assert.equal(isProviderRiskKind('multi_account'), false);
  assert.match(riskKindLabel('provider_drift'), /provider_drift/);
  assert.equal(riskKindLabel('multi_account'), 'multi_account');
});
