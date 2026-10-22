import { log } from './log.js';
import { loadDotEnv, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createSms } from './sms/index.js';
import { createUserApp } from './app.js';
import { createAdminApp } from './admin/app.js';
import { runExpirySweep } from './ledger.js';

loadDotEnv();
const cfg = loadConfig();
const db = openDb(cfg);
const sms = createSms(cfg);

function sweep() {
  try {
    const { warned, expired } = runExpirySweep(db, {
      onWarning: (lot) => {
        const daysLeft = Math.max(1, Math.ceil((lot.expires_at - Date.now()) / 86_400_000));
        const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(lot.user_id);
        if (user) void sms.sendExpiryWarning(user.phone, daysLeft, lot.tokens_left);
      },
      onExpired: (lot) => {
        const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(lot.user_id);
        if (user) void sms.sendExpired(user.phone, lot.tokens_left);
      },
    });
    if (warned || expired) log.info('expiry_sweep', { warned, expired });
  } catch (e) {
    log.error('expiry_sweep_failed', { error: e.message });
  }
}
sweep();
setInterval(sweep, 6 * 3_600_000).unref();

const api = createUserApp(db, cfg, sms);
const admin = createAdminApp(db, cfg, sms);
api.listen(cfg.port, cfg.host, () => log.info('user_api_started', { host: cfg.host, port: cfg.port, smsProvider: sms.provider.name }));
admin.listen(cfg.adminPort, cfg.host, () => log.info('admin_started', { host: cfg.host, port: cfg.adminPort, adminPhones: cfg.adminPhones.length }));
if (!cfg.upstreamBaseUrl) log.warn('upstream_not_configured', { note: '/v1/chat/completions will return 503 until configured' });
