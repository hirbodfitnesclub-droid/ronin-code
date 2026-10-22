/**
 * Supabase Auth (GoTrue) process control for the local dev stack.
 *
 * Production runs GoTrue inside Supabase Cloud, where it is configured via
 * the dashboard (phone provider = Send SMS Hook). Locally we run the official
 * `auth` binary (github.com/supabase/auth releases, pinned below) against
 * the local Postgres — same code, same auth schema, same behaviour.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GOTRUE_VERSION = 'v2.197.0';
export const GOTRUE_DOWNLOAD_URL =
  `https://github.com/supabase/auth/releases/download/${GOTRUE_VERSION}/auth-${GOTRUE_VERSION}-amd64.tar.xz`;

export function gotrueBin() {
  const candidates = [
    process.env.GOTRUE_BIN,
    path.join(SERVER_DIR, 'tools', 'auth'),
    '/tmp/ronin-tools/auth',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    `GoTrue binary not found. Download ${GOTRUE_DOWNLOAD_URL}, extract it to server/tools/auth (git-ignored), or set GOTRUE_BIN.`);
}

/** Build the env for `auth migrate` / `auth serve`. dbUrl is the SUPERUSER url. */
export function gotrueEnv({ dbUrl, port, hookUrl = null, hookSecret = null, jwtSecret, smsOtpExpSeconds = 300, smsMaxFrequency = '1s' }) {
  const env = {
    ...process.env,
    GOTRUE_API_HOST: '127.0.0.1',
    GOTRUE_API_PORT: String(port),
    GOTRUE_DB_DRIVER: 'postgres',
    GOTRUE_DB_DATABASE_URL: dbUrl,
    GOTRUE_SITE_URL: 'http://127.0.0.1:7443',
    API_EXTERNAL_URL: `http://127.0.0.1:${port}`,
    GOTRUE_JWT_SECRET: jwtSecret,
    GOTRUE_JWT_EXP: '900',                       // 15-minute access tokens (product rule)
    GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_EXTERNAL_PHONE_ENABLED: 'true',
    GOTRUE_SMS_OTP_EXP: String(smsOtpExpSeconds), // 5-minute OTP (product rule)
    GOTRUE_SMS_OTP_LENGTH: '6',
    GOTRUE_SMS_MAX_FREQUENCY: smsMaxFrequency,    // product layer enforces 60s; local stacks relax it
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true',
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: '0',
    GOTRUE_LOG_LEVEL: 'warn',
  };
  if (hookUrl) {
    env.GOTRUE_HOOK_SEND_SMS_ENABLED = 'true';
    env.GOTRUE_HOOK_SEND_SMS_URI = hookUrl;
    env.GOTRUE_HOOK_SEND_SMS_SECRETS = hookSecret;
  }
  return env;
}

export async function migrateGotrue(env) {
  await run(gotrueBin(), ['migrate'], { env });
}

/** Spawn `auth serve`; resolves once /health answers. Returns { stop, port }. */
export async function startGotrue(env, { logFile = null } = {}) {
  const out = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : 'ignore';
  const child = spawn(gotrueBin(), ['serve'], { env, stdio: ['ignore', out, out] });
  const port = env.GOTRUE_API_PORT;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`GoTrue exited early (code ${child.exitCode})`);
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('GoTrue did not become healthy in 30s'); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((r) => child.once('exit', r)),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  };
}
