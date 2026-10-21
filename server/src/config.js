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
    dbPath: env.DB_PATH || path.join(SERVER_DIR, 'data', 'ronin.db'),
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
    tokensPerUsd: int(env.TOKENS_PER_USD, 5_000_000),
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
    maxDevices: int(env.MAX_DEVICES, 2),
    chatRatePerMin: int(env.CHAT_RATE_PER_MIN, 60),
    chatMaxConcurrent: int(env.CHAT_MAX_CONCURRENT, 3),
    ...overrides,
  };
  if (!cfg.authSecret) {
    cfg.authSecret = crypto.randomBytes(32).toString('hex');
    cfg.authSecretEphemeral = true;
    console.warn('[ronin] AUTH_SECRET is not set — generated an ephemeral one (OTP codes will not survive a restart).');
  }
  return cfg;
}
