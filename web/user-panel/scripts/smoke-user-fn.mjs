// Local smoke for the Vercel user function (api/index.js) — NO deployment.
//
// Boots the same local stack the server tests use (embedded Postgres +
// GoTrue migrations + our migrations, per server/test/helpers.mjs), then
// serves THIS panel's function entry over real HTTP via http.createServer
// and asserts status codes only. Output is statuses only — no bodies, no
// codes, no secrets.
//
// Requires the GoTrue binary, exactly like the server test suite
// (GOTRUE_BIN, server/tools/auth, or /tmp/ronin-tools/auth).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { startPostgres } from '../../../server/scripts/pg-runtime.mjs';
import { gotrueEnv, migrateGotrue, startGotrue } from '../../../server/scripts/gotrue.mjs';
import { applyLocalPrereqs, applyLocalAuthGrants, applyMigrations } from '../../../server/scripts/migrate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. Fresh copy of the server source into api/_lib/server (the function
//    entry imports from there).
execFileSync(process.execPath, [path.join(here, 'sync-api.mjs')], { stdio: 'ignore' });

// Test fixtures only — the same throwaway values the server test suite uses.
const JWT_SECRET = 'ronin-test-jwt-secret-0123456789abcdef';
const HOOK_SECRET = `v1,whsec_${Buffer.from('ronin-test-hook-secret-0123456789').toString('base64')}`;
const SWEEP_SECRET = 'smoke-sweep-secret';
const PHONE = '09121111111';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let failures = 0;
function check(label, actual, expected) {
  console.log(`${label} -> ${actual}`);
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  if (!ok) { failures++; console.log(`FAIL ${label}: expected ${expected}`); }
}

// The function entry's console SMS provider logs OTPs in this process;
// capture the code from that log line and suppress the line itself.
let lastOtp = null;
const origLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(' ');
  const m = line.match(/\[sms:console\].*tokens=\["(\d+)"/);
  if (m) { lastOtp = m[1]; return; }
  origLog(...args);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-smoke-'));
const pgPort = await freePort();
const gotruePort = await freePort();
const pg = await startPostgres({ dataDir: path.join(dir, 'pg'), port: pgPort });
let gotrue = null;
let fnServer = null;
try {
  const admin = new Client({ connectionString: pg.url('postgres') });
  await admin.connect();
  await admin.query('CREATE DATABASE ronin_smoke');
  await admin.end();

  const superClient = new Client({ connectionString: pg.url('ronin_smoke') });
  await superClient.connect();
  await applyLocalPrereqs(superClient);
  await migrateGotrue(gotrueEnv({ dbUrl: pg.url('ronin_smoke'), port: gotruePort, jwtSecret: JWT_SECRET, smsMaxFrequency: '100ms' }));
  await applyLocalAuthGrants(superClient);
  await applyMigrations(superClient);
  await superClient.end();

  // Env for the function entry's lazy singletons (loadConfig reads env).
  process.env.DATABASE_URL = `postgres://service_role:ronin-local-service@127.0.0.1:${pgPort}/ronin_smoke`;
  process.env.SUPABASE_AUTH_URL = `http://127.0.0.1:${gotruePort}`;
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.SUPABASE_AUTH_HOOK_SEND_SMS_SECRET = HOOK_SECRET;
  process.env.AUTH_SECRET = 'test-secret';
  process.env.SMS_PROVIDER = 'console';
  process.env.SWEEP_SECRET = SWEEP_SECRET;
  delete process.env.CRON_SECRET;

  const { default: handler } = await import('../api/index.js');
  fnServer = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((r) => fnServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fnServer.address().port}`;

  gotrue = await startGotrue(gotrueEnv({
    dbUrl: pg.url('ronin_smoke'), port: gotruePort, jwtSecret: JWT_SECRET, smsMaxFrequency: '100ms',
    hookUrl: `${base}/hooks/send-sms`, hookSecret: HOOK_SECRET,
  }), { logFile: path.join(dir, 'gotrue.log') });

  const call = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };

  // healthz
  check('GET /healthz', (await call('/healthz')).status, 200);

  // Login via the real OTP flow (GoTrue -> send-sms hook -> console SMS).
  const otpReq = await call('/api/auth/otp/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE }),
  });
  check('POST /api/auth/otp/request', otpReq.status, 200);
  if (!lastOtp) throw new Error('no OTP captured from console SMS log');
  const verify = await call('/api/auth/otp/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, code: lastOtp, deviceName: 'smoke' }),
  });
  check('POST /api/auth/otp/verify', verify.status, 200);
  const token = verify.json?.accessToken;
  if (!token) throw new Error('login did not return an access token');

  // packs: 200 with exactly 4 packs
  const packs = await call('/api/packs', { headers: { Authorization: `Bearer ${token}` } });
  check('GET /api/packs', packs.status, 200);
  if (!Array.isArray(packs.json?.packs) || packs.json.packs.length !== 4) {
    failures++;
    origLog(`FAIL GET /api/packs: expected 4 packs, got ${packs.json?.packs?.length ?? 'none'}`);
  }

  // send-sms hook with an invalid signature -> 4xx
  const hook = await call('/hooks/send-sms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': 'smoke-invalid', 'webhook-timestamp': '0', 'webhook-signature': 'v1,invalid',
    },
    body: JSON.stringify({ user: { phone: '989121111111' }, sms: { otp: '000000' } }),
  });
  check('POST /hooks/send-sms (invalid signature)', hook.status, [400, 401, 403]);

  // internal sweep: unauthorized -> 404, authorized -> 200 JSON
  check('GET /api/internal/sweep (no secret)', (await call('/api/internal/sweep')).status, 404);
  const sweep = await call('/api/internal/sweep', { headers: { 'x-sweep-secret': SWEEP_SECRET } });
  check('GET /api/internal/sweep (with secret)', sweep.status, 200);
  if (!sweep.json || typeof sweep.json !== 'object') {
    failures++;
    origLog('FAIL GET /api/internal/sweep: expected a JSON body');
  }
} finally {
  console.log = origLog;
  if (gotrue) await gotrue.stop().catch(() => {});
  if (fnServer) { fnServer.closeAllConnections?.(); fnServer.close(); }
  await pg.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `SMOKE FAILED (${failures})` : 'SMOKE OK');
process.exit(failures ? 1 : 0);
