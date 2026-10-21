import { loadDotEnv, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createSms } from './sms/index.js';
import { createAdminApp } from './admin/app.js';

/** Run ONLY the standalone admin application (its own process + listener). */
loadDotEnv();
const cfg = loadConfig();
const db = openDb(cfg);
const sms = createSms(cfg);
createAdminApp(db, cfg, sms).listen(cfg.adminPort, cfg.host, () =>
  console.log(`[ronin] admin app (standalone) → http://${cfg.host}:${cfg.adminPort}`));
