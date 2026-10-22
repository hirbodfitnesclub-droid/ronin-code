import { HttpError, num, ms } from './util.js';

/**
 * Credit core — thin async wrappers over the SECURITY DEFINER RPCs.
 *
 * The invariants themselves (append-only ledger, balance == Σ lots, FIFO,
 * per-user serialization, idempotency) are enforced IN Postgres:
 * see supabase/migrations/20261022000002_rpc.sql. Nothing in JS mutates
 * ledger/lots/holds tables directly anymore.
 */

export async function ledgerBalance(db, userId) {
  const row = await db.one('SELECT public.ledger_balance($1) AS b', [userId]);
  return Number(row.b);
}

export async function spendableTokens(db, userId) {
  const row = await db.one('SELECT public.spendable_tokens($1) AS s', [userId]);
  return Number(row.s);
}

export async function unexpiredLotTokens(db, userId) {
  const row = await db.one(
    'SELECT COALESCE(SUM(tokens_left),0)::bigint AS s FROM public.credit_lots WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())',
    [userId]);
  return Number(row.s);
}

export async function activeHoldTokens(db, userId) {
  const row = await db.one(
    "SELECT COALESCE(SUM(reserved_tokens),0)::bigint AS s FROM public.holds WHERE user_id = $1 AND status = 'reserved'",
    [userId]);
  return Number(row.s);
}

/** Grant credit (purchase approval / admin manual charge): ledger entry + a lot. Idempotent on idempotencyKey. */
export async function grantCredit(db, { userId, tokens, kind = 'purchase', refType = null, refId = null, actor = null, note = null, meta = null, expiresAt = null, idempotencyKey = null }) {
  const row = await db.one(
    'SELECT public.grant_credit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
    [userId, tokens, kind, refType, refId !== null && refId !== undefined ? String(refId) : null,
     actor, note, meta ? JSON.stringify(meta) : null,
     expiresAt ? new Date(expiresAt).toISOString() : null, idempotencyKey]);
  return Number(row.id);
}

/** Map an RPC jsonb hold row back to the shape the proxy works with. */
export function mapHold(h) {
  if (!h) return h;
  return {
    id: Number(h.id),
    user_id: h.user_id,
    request_id: h.request_id,
    idempotency_key: h.idempotency_key,
    model: h.model,
    multiplier: Number(h.multiplier),
    reserved_tokens: Number(h.reserved_tokens),
    actual_tokens: h.actual_tokens === null || h.actual_tokens === undefined ? null : Number(h.actual_tokens),
    status: h.status,
    response_json: h.response_json ?? null,
    created_at: ms(h.created_at),
    settled_at: ms(h.settled_at),
  };
}

/**
 * Reserve (hold) the estimated max cost of a metered request.
 * The balance check happens INSIDE the RPC under the user-row lock, so
 * concurrent reserves can never overdraw. Returns { hold, replayed } or null
 * when funds are insufficient. An idempotency key replays the existing hold.
 */
export async function reserveHold(db, { userId, requestId, idempotencyKey = null, model, multiplier, reservedTokens, actor }) {
  const row = await db.one(
    'SELECT public.reserve_hold($1,$2,$3,$4,$5,$6,$7) AS r',
    [userId, requestId, idempotencyKey, model, multiplier, reservedTokens, actor]);
  const r = row.r;
  if (!r.ok) {
    if (r.error === 'insufficient_credit') return null;
    throw new Error(`reserve_hold failed: ${r.error}`);
  }
  return { hold: mapHold(r.hold), replayed: Boolean(r.replayed) };
}

/** Commit a hold: charge the actual metered cost (capped so balance never goes negative). No-op if already settled. */
export async function commitHold(db, { holdId, actualTokens, responseJson = null }) {
  const row = await db.one(
    'SELECT public.commit_hold($1,$2,$3::jsonb) AS r',
    [holdId, actualTokens, responseJson === null || responseJson === undefined ? null
      : typeof responseJson === 'string' ? responseJson : JSON.stringify(responseJson)]);
  return mapHold(row.r.hold);
}

/** Release a hold without charging (upstream error, client abort before start, …). */
export async function releaseHold(db, { holdId, reason = null }) {
  const row = await db.one('SELECT public.release_hold($1,$2) AS r', [holdId, reason]);
  return mapHold(row.r.hold);
}

/**
 * Admin manual adjustment (positive = grant, negative = debit). Always an
 * `adjust` ledger entry with the acting admin + a mandatory note (enforced
 * by the admin app). Throws 400 if a debit would take the balance below zero.
 */
export async function adjustCredit(db, { userId, tokens, actor, note }) {
  const row = await db.one('SELECT public.adjust_credit($1,$2,$3,$4) AS r', [userId, tokens, actor, note]);
  const r = row.r;
  if (!r.ok) {
    if (r.error === 'insufficient_balance') {
      throw new HttpError(400, 'insufficient_balance', 'Debit would take the balance below zero.');
    }
    throw new Error(`adjust_credit failed: ${r.error}`);
  }
  return Number(r.balance);
}

export async function userLedger(db, userId, limit = 50) {
  const rows = await db.many(
    `SELECT id, kind, delta_tokens, amount_tokens, balance_after, ref_type, ref_id, note, created_at
     FROM public.ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit]);
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind,
    deltaTokens: Number(r.delta_tokens),
    amountTokens: r.amount_tokens === null ? null : Number(r.amount_tokens),
    balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
    refType: r.ref_type, refId: r.ref_id, note: r.note,
    createdAt: ms(r.created_at),
  }));
}

/**
 * Expiry sweep: warn ~72h before a lot expires (once), and debit expired
 * leftovers through `expire` ledger entries (all inside the RPC). SMS
 * sending is left to the caller via the callbacks, which receive
 * { id, user_id, phone, tokens_left, expires_at(ms) } per affected lot.
 */
export async function runExpirySweep(db, notify = {}) {
  const row = await db.one('SELECT public.run_expiry_sweep() AS r');
  const { warned = [], expired = [] } = row.r ?? {};
  const shape = (l) => ({
    id: Number(l.lotId), user_id: l.userId, phone: l.phone,
    tokens_left: Number(l.tokensLeft), expires_at: ms(l.expiresAt),
  });
  for (const l of warned) notify.onWarning?.(shape(l));
  for (const l of expired) notify.onExpired?.(shape(l));
  return { warned: warned.length, expired: expired.length };
}
