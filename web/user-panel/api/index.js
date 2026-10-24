// Vercel function entry for the Ronin Code user API.
//
// The canonical server source lives in ../../../server/src and is copied
// into ./_lib/server at build time by scripts/sync-api.mjs (api/_lib/ is
// git-ignored). This entry lazily builds the same singletons the Node
// server (server/src/server.js) builds — cfg, db, sms — once per process,
// and delegates every request to the shared user handler, except the
// internal sweep endpoint below.
import crypto from 'node:crypto';
import { loadConfig } from './_lib/server/config.js';
import { createDb } from './_lib/server/db.js';
import { createSms } from './_lib/server/sms/index.js';
import { createUserHandler } from './_lib/server/app.js';
import { createWorker } from './_lib/server/reseller/worker.js';
import { reconcileSweep } from './_lib/server/reseller/reconcile.js';
import { runExpirySweep } from './_lib/server/ledger.js';
import { sendJson } from './_lib/server/http.js';

export const config = { maxDuration: 60 };

let state = null;
function getState() {
  if (!state) {
    const cfg = loadConfig();
    const db = createDb(cfg);
    const sms = createSms(cfg);
    const handler = createUserHandler(db, cfg, sms);
    state = { cfg, db, sms, handler };
  }
  return state;
}

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sweepAuthorized(req) {
  if (secretMatches(req.headers['x-sweep-secret'], process.env.SWEEP_SECRET)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && secretMatches(req.headers.authorization, `Bearer ${cron}`)) return true;
  return false;
}

const SWEEP_BUDGET_MS = 50_000;

async function handleSweep(req, res) {
  // Unauthorized (or any other /api/internal/* path) → 404: do not reveal
  // that the endpoint exists.
  const { pathname } = new URL(req.url, 'http://local');
  if (pathname !== '/api/internal/sweep' || (req.method !== 'GET' && req.method !== 'POST') || !sweepAuthorized(req)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  }
  const { db, cfg, sms } = getState();
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > SWEEP_BUDGET_MS;
  const out = {};

  // (a) Reseller worker drain (includes the backfill sweeper with sweep:true).
  if (overBudget()) {
    out.worker = { status: 'skipped_timeout' };
  } else {
    try {
      const worker = createWorker(db, cfg);
      const r = await worker.drainOnce({ sweep: true });
      out.worker = {
        status: 'ok', processed: Number(r?.processed ?? 0),
        ...(r?.blocked ? { blocked: String(r.blocked) } : {}),
      };
      // Keep the client the worker was built with for reconciliation —
      // exactly how worker.js obtains it (createWorker's default client).
      out._workerClient = worker.client;
    } catch {
      out.worker = { status: 'error' };
    }
  }

  // (b) Reconciliation sweep.
  if (overBudget()) {
    out.reconcile = { status: 'skipped_timeout' };
  } else {
    try {
      const workerClient = out._workerClient ?? createWorker(db, cfg).client;
      const r = await reconcileSweep(db, cfg, workerClient, { limit: 50 });
      out.reconcile = {
        status: 'ok', attempted: Number(r?.attempted ?? 0),
        ok: Number(r?.ok ?? 0), failed: Number(r?.failed ?? 0),
      };
    } catch {
      out.reconcile = { status: 'error' };
    }
  }
  delete out._workerClient;

  // (c) Ledger expiry sweep, with the same SMS warnings as server.js.
  if (overBudget()) {
    out.expiry = { status: 'skipped_timeout' };
  } else {
    try {
      const r = await runExpirySweep(db, {
        onWarning: (lot) => {
          const daysLeft = Math.max(1, Math.ceil((lot.expires_at - Date.now()) / 86_400_000));
          void sms.sendExpiryWarning(lot.phone, daysLeft, lot.tokens_left);
        },
        onExpired: (lot) => {
          void sms.sendExpired(lot.phone, lot.tokens_left);
        },
      });
      out.expiry = { status: 'ok', warned: Number(r?.warned ?? 0), expired: Number(r?.expired ?? 0) };
    } catch {
      out.expiry = { status: 'error' };
    }
  }

  return sendJson(res, 200, { ok: true, sweep: out });
}

export default async function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://local');
  if (pathname.startsWith('/api/internal/')) {
    try {
      return await handleSweep(req, res);
    } catch {
      if (!res.writableEnded) return sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error.' } });
      return undefined;
    }
  }
  let userHandler;
  try {
    userHandler = getState().handler;
  } catch {
    return sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error.' } });
  }
  return userHandler(req, res);
}
