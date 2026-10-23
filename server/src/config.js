import { log } from './log.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tiny .env loader (no dependency): reads server/.env if present. Real env wins. */
export function loadDotEnv() {
  const file = path.join(SERVER_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 7443),
    adminPort: int(env.ADMIN_PORT, 7444),
    cookieSecure: env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true',

    // ── Supabase (migration: data + accounts live in Postgres/Auth) ──────
    // Direct Postgres connection for our servers. Production: the project's
    // connection string (role: postgres). Local dev stack: the local
    // service_role login created by supabase/local/00_prereqs.sql.
    databaseUrl: env.DATABASE_URL || '',
    // Base URL of the Supabase Auth API (GoTrue).
    // Cloud: https://<ref>.supabase.co/auth/v1 · Local stack: http://127.0.0.1:<port>
    supabaseAuthUrl: (env.SUPABASE_AUTH_URL || '').replace(/\/$/, ''),
    // Anon key — sent as the `apikey` header the Cloud gateway requires.
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    // HS256 secret GoTrue signs JWTs with (self-hosted). When set, access
    // tokens are verified locally; otherwise via the Auth /user endpoint.
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '',
    // Send SMS Hook: GoTrue signs its calls with this Standard-Webhooks
    // secret; POST /hooks/send-sms verifies before delivering via Kavenegar.
    authHookSecret: env.SUPABASE_AUTH_HOOK_SEND_SMS_SECRET || '',
    // OTP lifetime the Auth server is configured with, in seconds (product
    // rule: 300 = 5 min). Our guard layer mirrors expiry from this value.
    otpTtlSeconds: int(env.OTP_TTL_SECONDS, 300),

    // ── Receipt storage (card-to-card claim photos) ──────────────────────
    // Production: Supabase Storage — project base URL + service-role key;
    // receipts live in the PRIVATE bucket `receipts` (migrations 3–4).
    // The project URL is derived from the Auth URL when SUPABASE_URL is
    // not set explicitly. The service-role key is used ONLY server-side
    // (storage signed URLs); never logged, never sent to a browser.
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, '')
      || (env.SUPABASE_AUTH_URL || '').replace(/\/auth\/v1\/?$/, '').replace(/\/$/, ''),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    // Local fallback (dev/tests, no Storage service): directory on disk that
    // honours the same object-key contract.
    receiptsDir: env.RECEIPTS_DIR || path.join(SERVER_DIR, 'data', 'receipts'),
    // Upload rules: images only, at most 5 MiB.
    receiptMaxBytes: int(env.RECEIPT_MAX_BYTES, 5 * 1024 * 1024),
    // Lifetime of the signed receipt URLs minted for the admin panel.
    receiptUrlTtlSec: int(env.RECEIPT_URL_TTL_SECONDS, 600),

    // ── Admin panel extras (PRD §6) ──────────────────────────────────────
    // AI analyst chat (admin, on-demand only): an OpenAI-compatible gateway.
    // Falls back to the metering upstream config (resolved after overrides
    // are merged, below) when not set separately.
    analystBaseUrl: (env.ANALYST_BASE_URL || '').replace(/\/$/, ''),
    analystApiKey: env.ANALYST_API_KEY || '',
    analystModel: env.ANALYST_MODEL || 'deepseek-v4.1-flash',

    authSecret: env.AUTH_SECRET || '',
    adminPhones: list(env.ADMIN_PHONES),
    smsProvider: (env.SMS_PROVIDER || 'console').toLowerCase(),
    kavenegarApiKey: env.KAVENEGAR_API_KEY || '',
    smsTemplates: {
      otp: env.KAVENEGAR_TEMPLATE || env.SMS_PATTERN_OTP || '',
      packageActivated: env.KAVENEGAR_TEMPLATE_PACKAGE_ACTIVATED || '',
      expiryWarning: env.KAVENEGAR_TEMPLATE_EXPIRY_WARNING || '',
      expired: env.KAVENEGAR_TEMPLATE_EXPIRED || '',
      orderRejected: env.KAVENEGAR_TEMPLATE_ORDER_REJECTED || '',
    },
    smsAllowlist: list(env.SMS_ALLOWLIST),
    shopCard: {
      number: env.SHOP_CARD_NUMBER || '',
      holder: env.SHOP_CARD_HOLDER || '',
      bank: env.SHOP_CARD_BANK || '',
    },
    tokensPerUsd: int(env.TOKENS_PER_USD, 20_000_000),
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || '',

    // ── Phase 2: per-user provider keys (reseller) ─────────────────────
    // Control-plane primary key + base URL; values ONLY from env, never
    // logged/returned/stored. cvcBaseUrl carries NO /v1 suffix (contract).
    cvcBaseUrl: (env.CVC_BASE_URL || '').replace(/\/$/, ''),
    cvcPrimaryApiKey: env.CVC_PRIMARY_API_KEY || '',
    // AES-256-GCM key for delegated keys at rest: base64, exactly 32 bytes.
    cvcKeyEncryptionKey: env.CVC_KEY_ENCRYPTION_KEY || '',
    resellerDrainMs: int(env.RESELLER_DRAIN_MS, 15_000),
    resellerBackoffBaseMs: int(env.RESELLER_BACKOFF_BASE_MS, 30_000),
    cvcMutationTimeoutMs: int(env.CVC_MUTATION_TIMEOUT_MS, 10_000),
    cvcReadTimeoutMs: int(env.CVC_READ_TIMEOUT_MS, 8_000),
    maxDevices: int(env.MAX_DEVICES, 2),
    chatRatePerMin: int(env.CHAT_RATE_PER_MIN, 60),
    chatMaxConcurrent: int(env.CHAT_MAX_CONCURRENT, 3),
    ...overrides,
  };
  if (!cfg.analystBaseUrl) cfg.analystBaseUrl = cfg.upstreamBaseUrl;
  if (!cfg.analystApiKey) cfg.analystApiKey = cfg.upstreamApiKey;
  if (!cfg.authSecret) {
    cfg.authSecret = crypto.randomBytes(32).toString('hex');
    cfg.authSecretEphemeral = true;
    log.warn('auth_secret_ephemeral', { note: 'AUTH_SECRET not set — generated an ephemeral one (admin OTP codes will not survive a restart)' });
  }
  return cfg;
}
