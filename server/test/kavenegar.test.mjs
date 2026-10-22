import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createKavenegarProvider } from '../src/sms/kavenegar.js';
import { createSms } from '../src/sms/index.js';

// Kavenegar Verify Lookup, aligned to Shot's verified production call
// (api/_shot/auth.py): POST form-encoded to /v1/{key}/verify/lookup.json,
// receptor in local 09xxxxxxxxx format, success ⇔ HTTP 200 + return.status
// 200. Fetch is stubbed — NO real SMS is ever sent.
const CFG = {
  kavenegarApiKey: 'TESTKEY',
  smsAllowlist: [],
  smsProvider: 'kavenegar',
  smsTemplates: { otp: 'Shot', packageActivated: '', expiryWarning: '', expired: '', orderRejected: '' },
};

let realFetch, calls;
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status, body) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('verify lookup: URL, method and form params match Shot exactly', async () => {
  stubFetch(200, { return: { status: 200, message: 'ok' }, entries: [] });
  const provider = createKavenegarProvider(CFG);
  const out = await provider.sendTemplate('09121111111', 'Shot', ['123456']);
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.kavenegar.com/v1/TESTKEY/verify/lookup.json');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(calls[0].opts.body);
  assert.equal(form.get('receptor'), '09121111111'); // local format, as in Shot
  assert.equal(form.get('token'), '123456');
  assert.equal(form.get('template'), 'Shot');
});

test('verify lookup: non-200 return status maps to an error', async () => {
  stubFetch(200, { return: { status: 401, message: 'invalid' } });
  const provider = createKavenegarProvider(CFG);
  await assert.rejects(() => provider.sendTemplate('09121111111', 'Shot', ['123456']), /Kavenegar send failed/);
});

test('verify lookup: HTTP failure maps to an error', async () => {
  stubFetch(500, {});
  const provider = createKavenegarProvider(CFG);
  await assert.rejects(() => provider.sendTemplate('09121111111', 'Shot', ['123456']), /Kavenegar send failed/);
});

test('provider selection: kavenegar activates via SMS_PROVIDER, console is the default', async () => {
  assert.equal(createSms(CFG).provider.name, 'kavenegar');
  assert.equal(createSms({ ...CFG, smsProvider: 'console' }).provider.name, 'console');
  // No template configured → send is skipped, not attempted (Shot posture).
  const provider = createKavenegarProvider(CFG);
  assert.deepEqual(await provider.sendTemplate('09121111111', '', ['123456']), { skipped: true, reason: 'no_template_configured' });
  assert.equal(calls.length, 0);
});
