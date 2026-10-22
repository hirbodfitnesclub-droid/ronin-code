/**
 * Full local development stack — no Docker, no Supabase Cloud account:
 *
 *   real PostgreSQL (zonky binaries) ──▶ GoTrue migrate ──▶ our migrations
 *   ──▶ user API :7443 + admin :7444 ──▶ GoTrue serve (Send SMS Hook → API)
 *
 * Usage:  npm run dev        (from server/)
 * Data persists in os.tmpdir()/ronin-dev-pg; delete it for a clean slate.
 * SMS provider is `console`: OTP codes are printed in this terminal.
 * Dev-only secrets below are fixed so restarts keep working; production
 * values come from the environment (see .env.example).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startPostgres } from './pg-runtime.mjs';
import { gotrueEnv, migrateGotrue, startGotrue } from './gotrue.mjs';
import { applyLocalPrereqs, applyLocalAuthGrants, applyMigrations } from './migrate.mjs';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createSms } from '../src/sms/index.js';
import { createUserApp } from '../src/app.js';
import { createAdminApp } from '../src/admin/app.js';

const PG_PORT = 55432;
const GOTRUE_PORT = 9999;
const DB_NAME = 'ronin_dev';
const JWT_SECRET = 'ronin-dev-jwt-secret-0123456789abcdef';
const HOOK_SECRET = `v1,whsec_${Buffer.from('ronin-dev-hook-secret-0123456789').toString('base64')}`;

const pg = await startPostgres({ dataDir: path.join(os.tmpdir(), 'ronin-dev-pg', 'data'), port: PG_PORT });
console.log(`postgres → 127.0.0.1:${PG_PORT}`);

const admin = new Client({ connectionString: pg.url('postgres') });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
if (!exists.rowCount) await admin.query(`CREATE DATABASE ${DB_NAME}`);
await admin.end();

const superClient = new Client({ connectionString: pg.url(DB_NAME) });
await superClient.connect();
await applyLocalPrereqs(superClient);
await migrateGotrue(gotrueEnv({ dbUrl: pg.url(DB_NAME), port: GOTRUE_PORT, jwtSecret: JWT_SECRET }));
await applyLocalAuthGrants(superClient);
const applied = await applyMigrations(superClient);
await superClient.end();
console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations up to date');

const cfg = loadConfig({
  databaseUrl: `postgres://service_role:ronin-local-service@127.0.0.1:${PG_PORT}/${DB_NAME}`,
  supabaseAuthUrl: `http://127.0.0.1:${GOTRUE_PORT}`,
  supabaseJwtSecret: JWT_SECRET,
  authHookSecret: HOOK_SECRET,
  smsProvider: 'console',
});
const db = createDb(cfg);
const sms = createSms(cfg);
const api = createUserApp(db, cfg, sms);
const adminApp = createAdminApp(db, cfg, sms);
await Promise.all([
  new Promise((r) => api.listen(cfg.port, cfg.host, r)),
  new Promise((r) => adminApp.listen(cfg.adminPort, cfg.host, r)),
]);
const gotrue = await startGotrue(gotrueEnv({
  dbUrl: pg.url(DB_NAME), port: GOTRUE_PORT, jwtSecret: JWT_SECRET,
  hookUrl: `http://127.0.0.1:${cfg.port}/hooks/send-sms`, hookSecret: HOOK_SECRET,
}));

console.log(`user API  → http://${cfg.host}:${cfg.port}`);
console.log(`admin     → http://${cfg.host}:${cfg.adminPort}`);
console.log(`auth      → http://127.0.0.1:${GOTRUE_PORT}`);
console.log('ready — Ctrl+C to stop');

const shutdown = async () => {
  console.log('\nstopping…');
  api.close();
  adminApp.close();
  await gotrue.stop();
  await db.end();
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
