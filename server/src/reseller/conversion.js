import { getKeyRow, effectivePerUser } from './routing.js';
import { insertIntent } from './intents.js';

/**
 * Lazy v1→v2 conversion — design §9. The begin_provider_conversion RPC
 * freezes the amount exactly once (ledger marker + converted_at); this layer
 * then ensures the matching `convert` intent exists. Zero-amount conversions
 * set the marker only — no pointless 0-token key is created.
 *
 * GUARD (fuzz-found, 2026-10-23): a user who already HOLDS a provider key is
 * per-user native — there is nothing to convert, and running the RPC for
 * them would re-issue their whole lot balance a second time (their lots are
 * already represented by the key's allowance). Conversion only ever applies
 * to keyless v1 users.
 */
export async function ensureConversionIntent(db, cfg, userId, { amountOverride = null } = {}) {
  if (!(await effectivePerUser(db, cfg, userId))) return { status: 'not_applicable' };
  const existing = await getKeyRow(db, userId);
  if (existing?.encrypted_key) return { status: 'already_has_key' };
  const row = amountOverride === null || amountOverride === undefined
    ? await db.one('SELECT public.begin_provider_conversion($1) AS r', [userId])
    : await db.one('SELECT public.begin_provider_conversion($1,$2) AS r', [userId, Math.max(0, Math.floor(amountOverride))]);
  const r = row.r;
  if (!r.ok) return { status: r.error ?? 'failed' };
  if (r.status === 'deferred_holds_active') return { status: r.status };
  const amount = Number(r.amount ?? 0);
  if (amount <= 0) return { status: r.status, amount: 0 };
  const keyRow = await getKeyRow(db, userId);
  if (keyRow && Number(keyRow.token_limit_issued ?? 0) >= amount && keyRow.encrypted_key) {
    return { status: 'already_converted', amount };
  }
  const intent = await insertIntent(db, {
    userId, kind: 'convert', source: 'conversion',
    idempotencyKey: `conversion:${userId}`,
    ledgerIdempotencyKey: `convert:v1:${userId}`,
    amountTokens: amount, actor: 'system',
  });
  return { status: r.status, amount, intentId: intent ? Number(intent.id) : null };
}
