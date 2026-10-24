/**
 * Local proof for the Vercel admin function (api/index.js) — NO deploy.
 *
 * Boots a real local stack (embedded Postgres + GoTrue-migrated auth schema
 * + Ronin migrations + the contract-faithful mock CVC provider, the same
 * pieces server/test/helpers.mjs uses), serves api/index.js over real HTTP,
 * and asserts:
 *   1. GET /admin-api/session  unauthenticated → 401
 *   2. GET /admin-api/overview unauthenticated → 401
 *   3. FULL inline issuance: a claim (created through the same create_claim
 *      RPC the user API calls) approved through the admin FUNCTION reaches a
 *      terminal 'confirmed' intent + active provider key with NO resident
 *      worker running anywhere — issuance completed inside the review
 *      request itself (Workstream B).
 *
 * Output is statuses/counts only — never bodies, keys, or codes.
 *
 * Run: node scripts/smoke-admin-fn.mjs   (requires `npm install` in server/)
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '../../../server');
const ADMIN_PHONE = '09120000001';
const USER_PHONE_INTL = '989128888001'; // auth.users format; trigger maps to 09128888001

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// 0. Sync the server sources into api/_lib (the build-time artifact the
//    function imports), exactly as `npm run build` does.
execFileSync(process.execPath, [path.join(HERE, 'sync-api.mjs')], { stdio: 'inherit' });

const { startPostgres } = await import(path.join(SERVER_DIR, 'scripts/pg-runtime.mjs'));
const { gotrueEnv, migrateGotrue } = await import(path.join(SERVER_DIR, 'scripts/gotrue.mjs'));
const { applyLocalPrereqs, applyLocalAuthGrants, applyMigrations } = await import(path.join(SERVER_DIR, 'scripts/migrate.mjs'));
const { startMockCvc, MOCK_PRIMARY } = await import(path.join(SERVER_DIR, 'test/mock-cvc.mjs'));
const { createDb } = await import(path.join(SERVER_DIR, 'src/db.js'));
const { sha256Hex, randomToken } = await import(path.join(SERVER_DIR, 'src/util.js'));
const { setSetting } = await import(path.join(SERVER_DIR, 'src/settings.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-smoke-admin-'));
const pgPort = await freePort();
const gotruePort = await freePort();
const pg = await startPostgres({ dataDir: path.join(dir, 'pg'), port: pgPort });
const mockCvc = await startMockCvc();
let db = null;
let fnServer = null;

try {
  const adminClient = new Client({ connectionString: pg.url('postgres') });
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE ronin_smoke');
  await adminClient.end();

  const superClient = new Client({ connectionString: pg.url('ronin_smoke') });
  await superClient.connect();
  await applyLocalPrereqs(superClient);
  await migrateGotrue(gotrueEnv({
    dbUrl: pg.url('ronin_smoke'), port: gotruePort,
    jwtSecret: 'ronin-smoke-jwt-secret-0123456789abcdef', smsOtpExpSeconds: 300, smsMaxFrequency: '100ms',
  }));
  await applyLocalAuthGrants(superClient);
  await applyMigrations(superClient);
  await superClient.end();

  const databaseUrl = `postgres://service_role:ronin-local-service@127.0.0.1:${pgPort}/ronin_smoke`;

  // Test fixtures (setup shortcuts only — every assertion below goes through
  // the real function over HTTP or reads the resulting DB state).
  db = createDb({ databaseUrl });
  // auth.users belongs to GoTrue (superuser-owned): the fixture row goes in
  // over the superuser connection, like a real signup would create it.
  const superFixture = new Client({ connectionString: pg.url('ronin_smoke') });
  await superFixture.connect();
  const userRes = await superFixture.query(
    'INSERT INTO auth.users (id, phone) VALUES (gen_random_uuid(), $1) RETURNING id', [USER_PHONE_INTL]);
  await superFixture.end();
  const userId = userRes.rows[0].id; // the auth trigger created the public.users profile
  await setSetting(db, 'subscription_routing', { mode: 'shared', allowlist: [userId] });
  const claim = await db.one('SELECT public.create_claim($1,$2,$3,$4,$5,$6,$7) AS r',
    [userId, 'pack-1', 'smoke pack', 1000, 2_800_000, 'receipts/smoke.png', 'a'.repeat(64)]);
  if (!claim.r?.ok) throw new Error('create_claim fixture failed');
  const orderId = claim.r.order.id;
  const adminToken = randomToken(32);
  const csrf = randomToken(24);
  await db.query(
    "INSERT INTO public.admin_sessions (token_hash, phone, csrf_token, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')",
    [sha256Hex(adminToken), ADMIN_PHONE, csrf]);

  // The function reads its config from env (Vercel-style) at first request.
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    ADMIN_PHONES: ADMIN_PHONE,
    AUTH_SECRET: 'smoke-secret',
    SMS_PROVIDER: 'console',
    TOKENS_PER_USD: '1000',
    CVC_BASE_URL: mockCvc.url,
    CVC_PRIMARY_API_KEY: MOCK_PRIMARY,
    CVC_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    RECEIPTS_DIR: path.join(dir, 'receipts'),
  });

  const { default: handler } = await import('../api/index.js');
  fnServer = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((r) => fnServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fnServer.address().port}`;

  // 1+2. Unauthenticated guards.
  const s1 = await fetch(`${base}/admin-api/session`);
  check('GET /admin-api/session unauthenticated', s1.status === 401, `status=${s1.status}`);
  const s2 = await fetch(`${base}/admin-api/overview`);
  check('GET /admin-api/overview unauthenticated', s2.status === 401 || s2.status === 403, `status=${s2.status}`);

  // 3. Approve through the function; issuance must complete inline.
  const review = await fetch(`${base}/admin-api/orders/${orderId}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `ronin_admin=${encodeURIComponent(adminToken)}`,
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ action: 'approve' }),
  });
  check('POST /admin-api/orders/:id/review approve', review.status === 200, `status=${review.status}`);

  const intents = await db.many('SELECT state FROM public.key_issuance_intents WHERE user_id = $1', [userId]);
  check('issuance intents created', intents.length === 1, `count=${intents.length}`);
  check('intent terminal (confirmed) with no resident worker',
    intents.length === 1 && intents[0].state === 'confirmed', `state=${intents[0]?.state ?? 'none'}`);
  const keyRow = await db.one('SELECT status, token_limit_issued FROM public.user_provider_keys WHERE user_id = $1', [userId]);
  check('provider key active', keyRow?.status === 'active', `status=${keyRow?.status ?? 'none'}`);
  check('provider limit issued = 1000', Number(keyRow?.token_limit_issued ?? 0) === 1000,
    `issued=${Number(keyRow?.token_limit_issued ?? 0)}`);
  check('mock provider create calls = 1', mockCvc.state.calls.create === 1, `calls=${mockCvc.state.calls.create}`);
} finally {
  if (fnServer) { fnServer.closeAllConnections?.(); fnServer.close(); }
  await mockCvc.close().catch(() => {});
  if (db) await db.end().catch(() => {});
  await pg.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `SMOKE FAILED (${failures} check(s))` : 'SMOKE OK');
process.exit(failures ? 1 : 0);
