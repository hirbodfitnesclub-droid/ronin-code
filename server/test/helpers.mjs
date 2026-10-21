import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createSms } from '../src/sms/index.js';
import { createUserApp } from '../src/app.js';
import { createAdminApp } from '../src/admin/app.js';

export const ADMIN_PHONE = '09120000001';
export const USER_PHONE = '09121111111';

/** Fake OpenAI-compatible upstream: canned usage, call counter, optional failure. */
export function startFakeUpstream({ promptTokens = 100, completionTokens = 50 } = {}) {
  const state = { calls: 0, failNext: false, lastAuth: null, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      state.calls++;
      state.lastAuth = req.headers.authorization;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failNext) {
        state.failNext = false;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'salam' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

/** Full stack: user API + standalone admin app on ephemeral ports, temp DB, console SMS. */
export async function startStack(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-test-'));
  const upstream = await startFakeUpstream(overrides.upstreamUsage ?? {});
  const cfg = loadConfig({
    dbPath: path.join(dir, 'test.db'),
    authSecret: 'test-secret',
    smsProvider: 'console',
    adminPhones: [ADMIN_PHONE],
    upstreamBaseUrl: upstream.url,
    upstreamApiKey: 'upstream-test-key',
    tokensPerUsd: 1000,
    chatMaxConcurrent: 50,
    chatRatePerMin: 10_000,
    ...(overrides.cfg ?? {}),
  });
  const db = openDb(cfg);
  const sms = createSms(cfg);
  const api = createUserApp(db, cfg, sms);
  const admin = createAdminApp(db, cfg, sms);
  await Promise.all([
    new Promise((r) => api.listen(0, '127.0.0.1', r)),
    new Promise((r) => admin.listen(0, '127.0.0.1', r)),
  ]);
  return {
    db, cfg, sms, upstream,
    base: `http://127.0.0.1:${api.address().port}`,
    adminBase: `http://127.0.0.1:${admin.address().port}`,
    async close() {
      api.close(); admin.close(); upstream.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function req(base, path, { method = 'GET', token, cookie, csrf, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

export function lastOtpFor(sms, phone) {
  const hits = sms.outbox.filter((m) => m.phone === phone);
  if (!hits.length) throw new Error(`no SMS sent to ${phone}`);
  return hits[hits.length - 1].tokens[0];
}

/** Simulate time passing for OTP send-cooldowns between repeat logins. */
export function resetRateLimits(db) {
  db.exec('DELETE FROM rate_events');
}

export async function loginUser(stack, phone = USER_PHONE, deviceName = 'test-device') {
  resetRateLimits(stack.db);
  const r1 = await req(stack.base, '/api/auth/otp/request', { method: 'POST', body: { phone } });
  if (r1.status !== 200) throw new Error(`otp request failed: ${r1.status} ${r1.text}`);
  const code = lastOtpFor(stack.sms, phone);
  const r2 = await req(stack.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code, deviceName } });
  if (r2.status !== 200) throw new Error(`otp verify failed: ${r2.status} ${r2.text}`);
  return r2.json; // { accessToken, refreshToken, user, deviceId }
}

export async function loginAdmin(stack) {
  resetRateLimits(stack.db);
  const r1 = await req(stack.adminBase, '/admin-api/auth/otp/request', { method: 'POST', body: { phone: ADMIN_PHONE } });
  if (r1.status !== 200) throw new Error(`admin otp request failed: ${r1.status} ${r1.text}`);
  const code = lastOtpFor(stack.sms, ADMIN_PHONE);
  const r2 = await req(stack.adminBase, '/admin-api/auth/otp/verify', { method: 'POST', body: { phone: ADMIN_PHONE, code } });
  if (r2.status !== 200) throw new Error(`admin otp verify failed: ${r2.status} ${r2.text}`);
  const cookie = (r2.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, csrf: r2.json.csrfToken, phone: ADMIN_PHONE };
}

/** Give a user credit directly (test setup shortcut via the real ledger path). */
export async function grant(stack, userId, tokens) {
  const { adjustCredit } = await import('../src/ledger.js');
  return adjustCredit(stack.db, { userId, tokens, actor: 'admin:test', note: 'test grant' });
}
