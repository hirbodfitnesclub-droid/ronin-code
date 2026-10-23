import { log } from './log.js';
import { loadDotEnv, loadConfig } from './config.js';
import { createDb } from './db.js';
import { createSms } from './sms/index.js';
import { createUserApp } from './app.js';
import { createAdminApp } from './admin/app.js';
import { runExpirySweep } from './ledger.js';
import { createWorker } from './reseller/worker.js';
import { registerWorkerKick } from './reseller/intents.js';
import { encryptionReady } from './reseller/crypto.js';

loadDotEnv();
const cfg = loadConfig();
const db = createDb(cfg);
const sms = createSms(cfg);

async function sweep() {
  try {
    const { warned, expired } = await runExpirySweep(db, {
      onWarning: (lot) => {
        const daysLeft = Math.max(1, Math.ceil((lot.expires_at - Date.now()) / 86_400_000));
        void sms.sendExpiryWarning(lot.phone, daysLeft, lot.tokens_left);
      },
      onExpired: (lot) => {
        void sms.sendExpired(lot.phone, lot.tokens_left);
      },
    });
    if (warned || expired) log.info('expiry_sweep', { warned, expired });
  } catch (e) {
    log.error('expiry_sweep_failed', { error: e.message });
  }
}
void sweep();
setInterval(sweep, 6 * 3_600_000).unref();

// Phase 2 reseller worker (§3.3): intent drain (15 s) + backfill sweeper
// (60 s) + reconciliation sweep (15 min), all in-process, all unref'd.
if (cfg.cvcBaseUrl && cfg.cvcPrimaryApiKey) {
  if (!encryptionReady(cfg)) {
    log.error('cvc_key_encryption_key_invalid', { note: 'CVC_KEY_ENCRYPTION_KEY missing or not 32-byte base64 — per-user issuance/relay fail closed' });
  }
  const resellerWorker = createWorker(db, cfg);
  registerWorkerKick(() => resellerWorker.drainOnce());
  resellerWorker.start();
  log.info('reseller_worker_started', {});
} else {
  log.warn('reseller_not_configured', { note: 'CVC_BASE_URL / CVC_PRIMARY_API_KEY not set — Phase 2 issuance is dormant (shared mode)' });
}

const api = createUserApp(db, cfg, sms);
const admin = createAdminApp(db, cfg, sms);
api.listen(cfg.port, cfg.host, () => log.info('user_api_started', { host: cfg.host, port: cfg.port, smsProvider: sms.provider.name }));
admin.listen(cfg.adminPort, cfg.host, () => log.info('admin_started', { host: cfg.host, port: cfg.adminPort, adminPhones: cfg.adminPhones.length }));
if (!cfg.upstreamBaseUrl) log.warn('upstream_not_configured', { note: '/v1/chat/completions will return 503 until configured' });
if (!cfg.supabaseAuthUrl) log.warn('auth_not_configured', { note: 'SUPABASE_AUTH_URL is not set — OTP login will fail' });
if (!cfg.authHookSecret) log.warn('hook_secret_not_set', { note: '/hooks/send-sms accepts UNSIGNED calls — set SUPABASE_AUTH_HOOK_SEND_SMS_SECRET outside local dev' });
