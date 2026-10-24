import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/lib/api.ts';
import { humanErrorText } from '../src/lib/errors.ts';
import { en } from '../src/lib/i18n/en.ts';
import { fa } from '../src/lib/i18n/fa.ts';

/* Error-handling audit regressions.
   Host error bodies come in two shapes: auth routes send
   { error: "<code>" } (the code IS the error field); turn/idea/export
   routes send { error: "<human sentence>", code: "<code>" }.
   INVARIANT: the user only ever sees a human message — never a raw
   code, a synthetic status string, raw HTML or browser error text. */

const tEn = (key: keyof typeof en) => en[key];
const tFa = (key: keyof typeof en) => fa[key];

/** Run `call` against a stubbed fetch that fails with `body`; return the thrown error. */
async function captureApiError(body: unknown, call: () => Promise<unknown>): Promise<ApiError> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  })) as typeof fetch;
  try {
    await call();
    assert.fail('expected the API call to throw');
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    return err;
  } finally {
    globalThis.fetch = original;
  }
}

/* ---------------- (1) request() error parsing ---------------- */

test('request(): auth-shaped body {error:"code_used"} → code set, message is NOT the raw code', async () => {
  const err = await captureApiError({ error: 'code_used' }, () => api.exchangeCode('RNC-XXXX-XXXX'));
  assert.equal(err.code, 'code_used');
  assert.notEqual(err.message, 'code_used');
  assert.equal(err.message, '');
});

test('request(): every code in the LoginScreen tables survives auth-shaped parsing', async () => {
  /* The CODE_ERROR_KEYS / OTP_ERROR_KEYS tables in LoginScreen.tsx are
     module-internal and the component cannot be imported under the
     Node test runner (React/JSX chain, no DOM), so the tables
     themselves are not directly unit-tested. What they need from the
     transport is exactly this: err.code === the code the host sent.
     These are the keys of both tables, copied from LoginScreen.tsx. */
  const loginCodes = [
    'invalid_code',
    'code_expired',
    'code_used',
    'handoff_rate_limited',
    'invalid_phone',
    'otp_wrong',
    'otp_expired',
    'otp_cooldown',
    'otp_daily_limit',
  ];
  for (const code of loginCodes) {
    const err = await captureApiError({ error: code }, () => api.requestOtp('09123456789'));
    assert.equal(err.code, code, `code ${code} must reach LoginScreen's tables`);
    assert.notEqual(err.message, code);
  }
});

test('request(): sentence-shaped body → code + human message preserved', async () => {
  const err = await captureApiError(
    { error: 'No project is open. Open or create a project first.', code: 'no_project' },
    () => api.startTurn('build it'),
  );
  assert.equal(err.code, 'no_project');
  assert.equal(err.message, 'No project is open. Open or create a project first.');
});

test('request(): human error with no code field → message preserved, code undefined', async () => {
  const err = await captureApiError({ error: 'That folder does not exist' }, () => api.selectProject('/nope'));
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'That folder does not exist');
});

test('request(): error identical to its code (model_not_enabled) → code kept, message empty', async () => {
  const err = await captureApiError({ error: 'model_not_enabled', code: 'model_not_enabled' }, () =>
    api.startTurn('build it'),
  );
  assert.equal(err.code, 'model_not_enabled');
  assert.equal(err.message, '');
});

test('request(): non-JSON error body → empty message, no synthetic "Request failed (N)"', async () => {
  const err = await captureApiError(new SyntaxError('Unexpected token < in JSON'), () => api.status());
  assert.equal(err.code, undefined);
  assert.equal(err.message, '');
  assert.ok(!/Request failed/.test(err.message));
});

/* ---------------- (2) humanErrorText ---------------- */

test('humanErrorText: mapped code → localised string (en and fa)', () => {
  const err = new ApiError('Your budget cap has been reached.', 'budget_exceeded');
  assert.equal(humanErrorText(err, tEn), en['errors.budget_exceeded']);
  assert.equal(humanErrorText(err, tFa), fa['errors.budget_exceeded']);
});

test('humanErrorText: code-only ApiError → fallback, never the code', () => {
  assert.equal(humanErrorText(new ApiError('', 'code_used'), tEn), en['errors.unknown']);
  /* Even a pre-fix-shaped error (message === raw code) must not leak it. */
  assert.equal(humanErrorText(new ApiError('code_used', 'code_used'), tEn), en['errors.unknown']);
  assert.equal(humanErrorText(new ApiError('login_required'), tEn), en['errors.unknown']);
  /* … and a caller-supplied fallback key is honoured. */
  assert.equal(
    humanErrorText(new ApiError('', 'login_required'), tEn, 'app.turnStartFailed'),
    en['app.turnStartFailed'],
  );
});

test('humanErrorText: human-sentence ApiError → the sentence', () => {
  assert.equal(humanErrorText(new ApiError('That folder does not exist'), tEn), 'That folder does not exist');
  assert.equal(
    humanErrorText(new ApiError('The endpoint URL is not a valid URL'), tEn),
    'The endpoint URL is not a valid URL',
  );
});

test('humanErrorText: browser / synthetic / raw payloads → fallback', () => {
  assert.equal(humanErrorText(new Error('Failed to fetch'), tEn), en['errors.unknown']);
  assert.equal(humanErrorText(new TypeError('Failed to fetch'), tEn), en['errors.unknown']);
  assert.equal(humanErrorText(new Error('Request failed (500)'), tEn), en['errors.unknown']);
  assert.equal(humanErrorText(new Error('Export failed (404)'), tEn), en['errors.unknown']);
  assert.equal(
    humanErrorText(new Error('<!DOCTYPE html><html><body><h1>404</h1></body></html>'), tEn),
    en['errors.unknown'],
  );
  assert.equal(humanErrorText(new Error(''), tEn), en['errors.unknown']);
  assert.equal(humanErrorText('code_used', tEn), en['errors.unknown']);
  assert.equal(humanErrorText(null, tEn), en['errors.unknown']);
  assert.equal(humanErrorText(undefined, tEn), en['errors.unknown']);
});
