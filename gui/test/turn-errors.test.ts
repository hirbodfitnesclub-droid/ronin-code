import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerForTurnError, looksLikeRawHtml, safeTurnText } from '../src/lib/turnErrors.ts';

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

test('hard battery: mid-stream 402 code lands on credit; frozen-relay code lands on locked, not model_disabled', () => {
  // H1: the host surfaces a mid-stream provider 402 as insufficient_credit.
  assert.equal(bannerForTurnError('insufficient_credit'), 'credit');
  // H3: the relay's frozen-key 403 arrives as subscription_locked from the
  // host (classifier fix) — the locked banner, while a genuine model
  // problem (model_disabled) must NOT be shown as locked or credit.
  assert.equal(bannerForTurnError('subscription_locked'), 'locked');
  assert.notEqual(bannerForTurnError('model_disabled'), 'locked');
  assert.notEqual(bannerForTurnError('model_disabled'), 'credit');
});

/* Bug 3 regression: a raw Russian 404 HTML page reached the chat as a
   message. The GUI must detect such payloads and show the localised
   generic turn error instead — never the payload itself. */
const HTML_404_RU =
  '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>404 Not Found</title></head>' +
  '<body><h1>404</h1><p>Страница не найдена</p></body></html>';

test('raw HTML payloads are detected: bare page and status-prefixed page', () => {
  assert.equal(looksLikeRawHtml(HTML_404_RU), true);
  assert.equal(looksLikeRawHtml(`404: ${HTML_404_RU}`), true);
});

test('ordinary chat text and fenced code samples are not raw payloads', () => {
  assert.equal(looksLikeRawHtml('Something went wrong during that turn.'), false);
  assert.equal(looksLikeRawHtml('Use a <div> wrapper for the layout'), false);
  assert.equal(looksLikeRawHtml('```html\n' + HTML_404_RU + '\n```'), false);
  assert.equal(looksLikeRawHtml(''), false);
  assert.equal(looksLikeRawHtml(null), false);
  assert.equal(looksLikeRawHtml(undefined), false);
});

test('safeTurnText swaps a raw payload for the fallback and keeps real messages', () => {
  const fallback = 'Something went wrong during that turn.';
  assert.equal(safeTurnText(HTML_404_RU, fallback), fallback);
  assert.equal(safeTurnText('The provider rejected this API key.', fallback), 'The provider rejected this API key.');
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
