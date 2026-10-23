import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerForTurnError } from '../src/lib/turnErrors.ts';

/* Phase 2 banner mapping (design §6.4): provider 402 through the relay
   keeps the EXISTING credit-exhausted banner; a frozen/suspended
   account keeps the EXISTING locked banner — never a model problem. */

test('402 / insufficient_credit shows the credit banner', () => {
  assert.equal(bannerForTurnError('insufficient_credit'), 'credit');
});

test('subscription_locked and account_suspended show the locked banner', () => {
  assert.equal(bannerForTurnError('subscription_locked'), 'locked');
  assert.equal(bannerForTurnError('account_suspended'), 'locked');
});

test('transient and generic codes show no banner', () => {
  assert.equal(bannerForTurnError('provider_key_not_ready'), null);
  assert.equal(bannerForTurnError('provider_key_invalid'), null);
  assert.equal(bannerForTurnError('model_disabled'), null);
  assert.equal(bannerForTurnError('login_required'), null);
  assert.equal(bannerForTurnError(undefined), null);
  assert.equal(bannerForTurnError(null), null);
  assert.equal(bannerForTurnError('something_else'), null);
});
