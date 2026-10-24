/**
 * Vercel function entry for the admin panel API (same-origin /admin-api/*,
 * rewritten here by vercel.json).
 *
 * There is NO resident reseller worker on Vercel, so issuance completes
 * INLINE: the admin handler awaits processInlineIntents() after each
 * intent-producing mutation, and the processor registered below drains the
 * queue synchronously — bounded by a 25 s race so a slow provider can never
 * hang the admin's request. Anything left pending is picked up by the daily
 * cron sweep or the admin resolve/retry actions (the durable intents are
 * the guarantee; this drain is the fast path).
 *
 * The server sources are synced at build time into ./_lib/server by
 * scripts/sync-api.mjs (git-ignored build artifact).
 */
import { loadConfig } from './_lib/server/config.js';
import { createDb } from './_lib/server/db.js';
import { createSms } from './_lib/server/sms/index.js';
import { createAdminHandler } from './_lib/server/admin/app.js';
import { registerInlineProcessor } from './_lib/server/reseller/intents.js';
import { createWorker } from './_lib/server/reseller/worker.js';

export const config = { maxDuration: 60 };

const INLINE_DRAIN_TIMEOUT_MS = 25_000;

let handler = null;

/** Lazy singletons: built once per warm function instance, never at import. */
function init() {
  if (handler) return handler;
  const cfg = loadConfig();
  const db = createDb(cfg);
  const sms = createSms(cfg);
  registerInlineProcessor(async () => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, INLINE_DRAIN_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([createWorker(db, cfg).drainOnce(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  });
  handler = createAdminHandler(db, cfg, sms);
  return handler;
}

export default async function adminApi(req, res) {
  return init()(req, res);
}
