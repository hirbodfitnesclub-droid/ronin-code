import { log } from '../log.js';
import { effectivePerUser, getKeyRow } from './routing.js';

/**
 * Intent producers — design §3.1/§4. Producers NEVER call the provider; they
 * only insert durable intent rows (deterministic idempotency keys make a
 * double insert a no-op). The backfill sweeper in worker.js is the guarantee;
 * these inline inserts are the fast path. A registered worker (server.js /
 * tests) is kicked after each insert — see registry.js.
 */

let kickFn = null;
export function registerWorkerKick(fn) { kickFn = fn; }
export function kickWorker() {
  if (!kickFn) return;
  Promise.resolve().then(() => kickFn()).catch((e) => log.warn('reseller_kick_failed', { error: e.message }));
}

export async function ensureKeyShell(db, userId) {
  const existing = await getKeyRow(db, userId);
  if (existing) return existing;
  const row = await db.one(
    `INSERT INTO public.user_provider_keys (user_id, provider_key_name, status)
     VALUES ($1, $2, 'pending_create')
     ON CONFLICT (user_id) DO UPDATE SET user_id = excluded.user_id
     RETURNING *`,
    [userId, `ronin-${String(userId).slice(0, 8)}-pending`]);
  return row;
}

/**
 * Insert one intent (idempotent on idempotency_key). For create/convert the
 * provider key name is finalised to ronin-<uuid8>-<intentId> here, once the
 * intent id exists (§2.1).
 */
export async function insertIntent(db, {
  userId, kind, source, amountTokens = null, targetTokenLimit = null,
  orderId = null, refundId = null, ledgerIdempotencyKey = null,
  idempotencyKey, actor = 'system',
}) {
  const shell = await ensureKeyShell(db, userId);
  const intent = await db.one(
    `INSERT INTO public.key_issuance_intents
       (user_id, user_provider_key_id, kind, source, order_id, refund_id,
        ledger_idempotency_key, idempotency_key, amount_tokens, target_token_limit, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [userId, shell.id, kind, source, orderId, refundId, ledgerIdempotencyKey,
     idempotencyKey, amountTokens, targetTokenLimit, actor]);
  if (!intent) {
    return (await db.one('SELECT * FROM public.key_issuance_intents WHERE idempotency_key = $1', [idempotencyKey])) ?? null;
  }
  if (kind === 'create' || kind === 'convert') {
    const name = `ronin-${String(userId).slice(0, 8)}-${intent.id}`;
    await db.query('UPDATE public.user_provider_keys SET provider_key_name = $2, updated_at = now() WHERE id = $1',
      [shell.id, name]);
  }
  kickWorker();
  return intent;
}

/** Claim approval (§3.1): create if no ciphertext yet, else topup. */
export async function ensureClaimIntent(db, cfg, { userId, orderId, grantedTokens, actor = 'system' }) {
  if (!(await effectivePerUser(db, cfg, userId))) return { state: 'not_applicable' };
  if (!grantedTokens || grantedTokens <= 0) return { state: 'not_applicable' };
  try {
    // Conversion first for a not-yet-converted user (§9.3): the convert
    // intent carries the OLD balance; this claim's intent follows in FIFO.
    const keyRow = await getKeyRow(db, userId);
    if (keyRow && !keyRow.converted_at) {
      const { ensureConversionIntent } = await import('./conversion.js');
      await ensureConversionIntent(db, cfg, userId).catch((e) =>
        log.warn('conversion_before_claim_failed', { error: e.message }));
    }
    const fresh = await getKeyRow(db, userId);
    const kind = fresh?.encrypted_key ? 'topup' : 'create';
    const intent = await insertIntent(db, {
      userId, kind, source: 'claim', orderId,
      ledgerIdempotencyKey: `order-approve:${orderId}`,
      idempotencyKey: `claim-issuance:${orderId}`,
      amountTokens: Number(grantedTokens), actor,
    });
    return { state: intent?.state ?? 'pending', intentId: intent ? Number(intent.id) : null, kind };
  } catch (e) {
    // The money event already committed — an intent-insert failure must not
    // fail the review; the sweeper backfills (§3.1 step 3).
    log.error('issuance_intent_insert_failed', { orderId: Number(orderId), error: e.message });
    return { state: 'pending' };
  }
}

/** Generic post-commit mirror used by suspend/reactivate/close/refund/charge. */
export async function ensureMirrorIntent(db, cfg, spec) {
  if (!(await effectivePerUser(db, cfg, spec.userId))) return null;
  try {
    return await insertIntent(db, spec);
  } catch (e) {
    log.error('issuance_intent_insert_failed', { error: e.message, kind: spec.kind, source: spec.source });
    return null;
  }
}

export function publicIntent(i) {
  if (!i) return null;
  return {
    id: Number(i.id), userId: i.user_id, kind: i.kind, source: i.source,
    state: i.state, amountTokens: i.amount_tokens === null ? null : Number(i.amount_tokens),
    targetTokenLimit: i.target_token_limit === null ? null : Number(i.target_token_limit),
    orderId: i.order_id === null ? null : Number(i.order_id),
    refundId: i.refund_id === null ? null : Number(i.refund_id),
    attemptCount: Number(i.attempt_count), attempts: i.attempts ?? [],
    balanceBefore: i.balance_before === null ? null : Number(i.balance_before),
    usedBefore: i.used_before === null ? null : Number(i.used_before),
    providerHttpStatus: i.provider_http_status, providerErrorCode: i.provider_error_code,
    actor: i.actor, createdAt: i.created_at ? new Date(i.created_at).getTime() : null,
    completedAt: i.completed_at ? new Date(i.completed_at).getTime() : null,
  };
}
