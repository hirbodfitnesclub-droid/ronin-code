import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createSms } from '../src/sms/index.js';
import { createUserApp } from '../src/app.js';
import { createAdminApp } from '../src/admin/app.js';
import { startPostgres } from '../scripts/pg-runtime.mjs';
import { gotrueEnv, migrateGotrue, startGotrue } from '../scripts/gotrue.mjs';
import { applyLocalPrereqs, applyLocalAuthGrants, applyMigrations } from '../scripts/migrate.mjs';

export const ADMIN_PHONE = '09120000001';
export const USER_PHONE = '09121111111';

const GOTRUE_JWT_SECRET = 'ronin-test-jwt-secret-0123456789abcdef';
const HOOK_SECRET = `v1,whsec_${Buffer.from('ronin-test-hook-secret-0123456789').toString('base64')}`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** Fake OpenAI-compatible upstream: canned usage, call counter, optional failure. */
export function startFakeUpstream({ promptTokens = 100, completionTokens = 50 } = {}) {
  const state = { calls: 0, failNext: false, lastAuth: null, delayMs: 0, lastBody: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      state.calls++;
      state.lastAuth = req.headers.authorization;
      try { state.lastBody = JSON.parse(raw || '{}'); } catch { state.lastBody = null; }
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

/**
 * Full stack on the REAL production-shaped infrastructure: local Postgres
 * (genuine binaries) + real Supabase Auth (official GoTrue binary) + our
 * migrations + user API + standalone admin app on ephemeral ports, console
 * SMS. No mocks anywhere in the data/auth path.
 */
export async function startStack(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-test-'));
  const upstream = await startFakeUpstream(overrides.upstreamUsage ?? {});
  // Phase 2 mock provider (opt-in): faithful reseller contract + fault injection.
  let mockCvc = null;
  if (overrides.mockCvc) {
    const { startMockCvc, MOCK_PRIMARY } = await import('./mock-cvc.mjs');
    mockCvc = await startMockCvc();
    overrides = {
      ...overrides,
      cfg: {
        cvcBaseUrl: mockCvc.url, cvcPrimaryApiKey: MOCK_PRIMARY,
        cvcKeyEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
        cvcMutationTimeoutMs: 400, cvcReadTimeoutMs: 2000,
        resellerBackoffBaseMs: 10,
        ...(overrides.cfg ?? {}),
      },
    };
  }
  const pgPort = await freePort();
  const gotruePort = await freePort();
  const otpExpSeconds = overrides.gotrue?.smsOtpExpSeconds ?? 300;
  const pg = await startPostgres({ dataDir: path.join(dir, 'pg'), port: pgPort });
  let gotrue = null;
  let db = null;
  let api = null;
  let admin = null;
  try {
    const adminClient = new Client({ connectionString: pg.url('postgres') });
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE ronin_test');
    await adminClient.end();

    const superClient = new Client({ connectionString: pg.url('ronin_test') });
    await superClient.connect();
    await applyLocalPrereqs(superClient);
    const baseGotrueEnv = {
      dbUrl: pg.url('ronin_test'), port: gotruePort, jwtSecret: GOTRUE_JWT_SECRET,
      smsOtpExpSeconds: otpExpSeconds, smsMaxFrequency: '100ms',
    };
    await migrateGotrue(gotrueEnv(baseGotrueEnv));
    await applyLocalAuthGrants(superClient);
    await applyMigrations(superClient);
    await superClient.end();

    const cfg = loadConfig({
      databaseUrl: `postgres://service_role:ronin-local-service@127.0.0.1:${pgPort}/ronin_test`,
      supabaseAuthUrl: `http://127.0.0.1:${gotruePort}`,
      supabaseJwtSecret: GOTRUE_JWT_SECRET,
      authHookSecret: HOOK_SECRET,
      otpTtlSeconds: otpExpSeconds,
      authSecret: 'test-secret',
      smsProvider: 'console',
      adminPhones: [ADMIN_PHONE],
      upstreamBaseUrl: upstream.url,
      upstreamApiKey: 'upstream-test-key',
      tokensPerUsd: 1000,
      chatMaxConcurrent: 50,
      chatRatePerMin: 10_000,
      receiptsDir: path.join(dir, 'receipts'),
      ...(overrides.cfg ?? {}),
    });
    db = createDb(cfg);
    const sms = createSms(cfg);
    api = createUserApp(db, cfg, sms);
    admin = createAdminApp(db, cfg, sms);
    await Promise.all([
      new Promise((r) => api.listen(0, '127.0.0.1', r)),
      new Promise((r) => admin.listen(0, '127.0.0.1', r)),
    ]);
    gotrue = await startGotrue(gotrueEnv({
      ...baseGotrueEnv,
      hookUrl: `http://127.0.0.1:${api.address().port}/hooks/send-sms`,
      hookSecret: HOOK_SECRET,
    }), { logFile: path.join(dir, 'gotrue.log') });

    return {
      db, cfg, sms, upstream, mockCvc,
      base: `http://127.0.0.1:${api.address().port}`,
      adminBase: `http://127.0.0.1:${admin.address().port}`,
      async close() {
        if (gotrue) await gotrue.stop();
        api.closeAllConnections?.();
        admin.closeAllConnections?.();
        api.close();
        admin.close();
        upstream.server.close();
        if (mockCvc) await mockCvc.close();
        await db.end();
        await pg.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (gotrue) await gotrue.stop().catch(() => {});
    if (db) await db.end().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
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
export async function resetRateLimits(db) {
  await db.query('DELETE FROM public.rate_events');
}

/**
 * Request an OTP, pacing GoTrue's built-in per-user SMS limiter (1 send per
 * wall-clock second, not configurable below that): on a cooldown response,
 * wait a beat and retry — the test-time equivalent of resetRateLimits for
 * our own limiter.
 */
async function requestOtpPaced(base, phone, admin = false) {
  const path = admin ? '/admin-api/auth/otp/request' : '/api/auth/otp/request';
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req(base, path, { method: 'POST', body: { phone } });
    if (r.status === 200) return r;
    if (r.status !== 429) return r;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return req(base, path, { method: 'POST', body: { phone } });
}

export async function loginUser(stack, phone = USER_PHONE, deviceName = 'test-device') {
  await resetRateLimits(stack.db);
  const r1 = await requestOtpPaced(stack.base, phone);
  if (r1.status !== 200) throw new Error(`otp request failed: ${r1.status} ${r1.text}`);
  const code = lastOtpFor(stack.sms, phone);
  const r2 = await req(stack.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code, deviceName } });
  if (r2.status !== 200) throw new Error(`otp verify failed: ${r2.status} ${r2.text}`);
  return r2.json; // { accessToken, refreshToken, user, deviceId }
}

export async function loginAdmin(stack) {
  await resetRateLimits(stack.db);
  const r1 = await requestOtpPaced(stack.adminBase, ADMIN_PHONE, true);
  if (r1.status !== 200) throw new Error(`admin otp request failed: ${r1.status} ${r1.text}`);
  const code = lastOtpFor(stack.sms, ADMIN_PHONE);
  const r2 = await req(stack.adminBase, '/admin-api/auth/otp/verify', { method: 'POST', body: { phone: ADMIN_PHONE, code } });
  if (r2.status !== 200) throw new Error(`admin otp verify failed: ${r2.status} ${r2.text}`);
  const cookie = (r2.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, csrf: r2.json.csrfToken, phone: ADMIN_PHONE };
}

/** A real 1×1 transparent PNG — the canonical test receipt image. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

/** POST a receipt-only claim (multipart/form-data) like the real client. */
export async function postClaim(base, token, packId, { data = PNG_1PX, contentType = 'image/png', filename = 'receipt.png', field = 'receipt' } = {}) {
  const form = new FormData();
  form.set('packId', packId);
  if (data !== null) form.set(field, new Blob([data], { type: contentType }), filename);
  const res = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/** Give a user credit directly (test setup shortcut via the real RPC path). */
export async function grant(stack, userId, tokens) {
  const { adjustCredit } = await import('../src/ledger.js');
  return adjustCredit(stack.db, { userId, tokens, actor: 'admin:test', note: 'test grant' });
}
