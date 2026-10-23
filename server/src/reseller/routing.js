import { getSetting, setSetting } from '../settings.js';

/**
 * Feature flag — design §11. Settings document `subscription_routing`:
 *   { mode: 'shared'|'per_user', allowlist: [userId, …] }
 * Absent document ⇒ shared (the safe default; stage-0 dormant deploy).
 * Effective per-user mode additionally requires, for PROXY routing, a usable
 * key — see routedPerUser().
 */

export async function getRouting(db, cfg) {
  const doc = await getSetting(db, cfg, 'subscription_routing').catch(() => null);
  if (!doc || (doc.mode !== 'per_user' && doc.mode !== 'shared')) {
    return { mode: 'shared', allowlist: [] };
  }
  return { mode: doc.mode, allowlist: Array.isArray(doc.allowlist) ? doc.allowlist.map(String) : [] };
}

export async function setRouting(db, value) {
  const mode = value?.mode === 'per_user' ? 'per_user' : 'shared';
  const allowlist = Array.isArray(value?.allowlist) ? value.allowlist.map(String) : [];
  await setSetting(db, 'subscription_routing', { mode, allowlist });
  return { mode, allowlist };
}

/** Issuance decision: should intents be created for this user at all? */
export async function effectivePerUser(db, cfg, userId) {
  const r = await getRouting(db, cfg);
  return r.mode === 'per_user' || r.allowlist.includes(String(userId));
}

/** Routing mode string reported to host/panels. */
export async function routingModeFor(db, cfg, userId) {
  return (await effectivePerUser(db, cfg, userId)) ? 'per_user' : 'shared';
}

export async function getKeyRow(db, userId) {
  return (await db.one('SELECT * FROM public.user_provider_keys WHERE user_id = $1', [userId])) ?? null;
}

/**
 * Proxy routing decision (§11.1/§9.2): per-user iff the flag reaches the user
 * AND they hold a confirmed key (conversion-created or purchase-created).
 * Frozen keys still route per-user so the relay can answer account_suspended.
 */
export async function routedPerUser(db, cfg, userId) {
  if (!(await effectivePerUser(db, cfg, userId))) return { perUser: false, keyRow: null };
  const keyRow = await getKeyRow(db, userId);
  if (!keyRow?.encrypted_key) return { perUser: false, keyRow };
  if (!['active', 'frozen', 'needs_attention'].includes(keyRow.status)) return { perUser: false, keyRow };
  return { perUser: true, keyRow };
}

/** Issuance circuit breaker (§3.4): DB-backed so every app/worker sees it. */
export async function breakerOpen(db, cfg) {
  const doc = await getSetting(db, cfg, 'provider_issuance_breaker').catch(() => null);
  return Boolean(doc?.open);
}
export async function setBreaker(db, open, meta = {}) {
  await setSetting(db, 'provider_issuance_breaker', { open: Boolean(open), ...meta, at: new Date().toISOString() });
}
