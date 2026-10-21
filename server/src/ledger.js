import { tx } from './db.js';

/**
 * Credit core — the append-only ledger (security-review design, Liro-proven shape).
 *
 * Invariants:
 *  - Balance = SUM(ledger.delta_tokens) for the user. It is NEVER written directly.
 *  - Ledger balance == SUM(credit_lots.tokens_left) at all times (the expiry sweep
 *    preserves this by debiting expired leftovers through an `expire` entry).
 *  - Spendable = unexpired lots, minus active hold reservations.
 *  - All mutations happen inside BEGIN IMMEDIATE transactions (single writer),
 *    so concurrent reserves can never overdraw.
 */

export function ledgerBalance(db, userId) {
  const { s } = db.prepare('SELECT COALESCE(SUM(delta_tokens),0) AS s FROM ledger WHERE user_id = ?').get(userId);
  return s;
}

export function unexpiredLotTokens(db, userId, nowMs = Date.now()) {
  const { s } = db.prepare(
    'SELECT COALESCE(SUM(tokens_left),0) AS s FROM credit_lots WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)'
  ).get(userId, nowMs);
  return s;
}

export function activeHoldTokens(db, userId) {
  const { s } = db.prepare(
    "SELECT COALESCE(SUM(reserved_tokens),0) AS s FROM holds WHERE user_id = ? AND status = 'reserved'"
  ).get(userId);
  return s;
}

export function spendableTokens(db, userId, nowMs = Date.now()) {
  return unexpiredLotTokens(db, userId, nowMs) - activeHoldTokens(db, userId);
}

function postLedger(db, { userId, kind, deltaTokens = 0, amountTokens = null, refType = null, refId = null,
  actor = null, idempotencyKey = null, requestId = null, note = null, meta = null }) {
  const balanceAfter = ledgerBalance(db, userId) + deltaTokens;
  const info = db.prepare(`INSERT INTO ledger
    (user_id, kind, delta_tokens, amount_tokens, balance_after, ref_type, ref_id, actor, idempotency_key, request_id, note, meta, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    userId, kind, deltaTokens, amountTokens, balanceAfter, refType,
    refId !== null && refId !== undefined ? String(refId) : null,
    actor, idempotencyKey, requestId, note,
    meta ? JSON.stringify(meta) : null, Date.now());
  return Number(info.lastInsertRowid);
}

/** Grant credit (purchase approval / admin manual charge): ledger entry + a lot. Must run inside tx(). */
export function grantCredit(db, { userId, tokens, kind = 'purchase', refType, refId, actor, note = null, meta = null, expiresAt = null, idempotencyKey = null }) {
  const entryId = postLedger(db, { userId, kind, deltaTokens: tokens, refType, refId, actor, note, meta, idempotencyKey });
  db.prepare('INSERT INTO credit_lots (user_id, source, tokens_total, tokens_left, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, `${refType ?? 'grant'}:${refId ?? entryId}`, tokens, tokens, expiresAt, Date.now());
  return entryId;
}

/** Consume tokens from lots, oldest-expiring first (FIFO). Must run inside tx(). Caller guarantees coverage. */
export function consumeLots(db, userId, tokens, nowMs = Date.now()) {
  let remaining = tokens;
  const lots = db.prepare(`SELECT * FROM credit_lots
    WHERE user_id = ? AND tokens_left > 0 AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY (expires_at IS NULL), expires_at ASC, id ASC`).all(userId, nowMs);
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.tokens_left, remaining);
    db.prepare('UPDATE credit_lots SET tokens_left = tokens_left - ? WHERE id = ?').run(take, lot.id);
    remaining -= take;
  }
  return tokens - remaining; // actually consumed
}

/**
 * Reserve (hold) the estimated max cost of a metered request.
 * Balance is checked INSIDE the transaction → concurrent reserves cannot overdraw.
 * Returns the hold row, or null when funds are insufficient.
 * An idempotency key replays the existing hold instead of double-reserving.
 */
export function reserveHold(db, { userId, requestId, idempotencyKey = null, model, multiplier, reservedTokens, actor }) {
  return tx(db, () => {
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM holds WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
      if (existing) return { hold: existing, replayed: true };
    }
    if (spendableTokens(db, userId) < reservedTokens) return null;
    const info = db.prepare(`INSERT INTO holds (user_id, request_id, idempotency_key, model, multiplier, reserved_tokens, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, requestId, idempotencyKey, model, multiplier, reservedTokens, Date.now());
    const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(Number(info.lastInsertRowid));
    postLedger(db, { userId, kind: 'hold', deltaTokens: 0, amountTokens: reservedTokens, refType: 'hold', refId: hold.id, actor, requestId });
    return { hold, replayed: false };
  });
}

/** Commit a hold: charge the actual metered cost (capped at what the balance can cover). */
export function commitHold(db, { holdId, actualTokens, responseJson = null }) {
  return tx(db, () => {
    const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
    if (!hold || hold.status !== 'reserved') return hold; // already settled → no double charge
    // Debit can never take the ledger below zero (prepaid model).
    const charge = Math.max(0, Math.min(actualTokens, ledgerBalance(db, hold.user_id)));
    consumeLots(db, hold.user_id, charge);
    postLedger(db, {
      userId: hold.user_id, kind: 'consume', deltaTokens: -charge,
      refType: 'hold', refId: hold.id, actor: 'system', requestId: hold.request_id,
      meta: { model: hold.model, multiplier: hold.multiplier, reservedTokens: hold.reserved_tokens, uncappedActual: actualTokens },
    });
    db.prepare("UPDATE holds SET status = 'committed', actual_tokens = ?, response_json = ?, settled_at = ? WHERE id = ?")
      .run(actualTokens, responseJson, Date.now(), holdId);
    return db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
  });
}

/** Release a hold without charging (upstream error, client abort before start, …). */
export function releaseHold(db, { holdId, reason = null }) {
  return tx(db, () => {
    const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
    if (!hold || hold.status !== 'reserved') return hold;
    postLedger(db, {
      userId: hold.user_id, kind: 'release', deltaTokens: 0, amountTokens: hold.reserved_tokens,
      refType: 'hold', refId: hold.id, actor: 'system', requestId: hold.request_id,
      meta: reason ? { reason } : null,
    });
    // Free the idempotency key so a legitimate client retry after an upstream
    // failure can reserve again (the hold row itself stays for audit).
    db.prepare("UPDATE holds SET status = 'released', settled_at = ?, idempotency_key = NULL WHERE id = ?").run(Date.now(), holdId);
    return db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
  });
}

export function userLedger(db, userId, limit = 50) {
  return db.prepare('SELECT id, kind, delta_tokens AS deltaTokens, amount_tokens AS amountTokens, balance_after AS balanceAfter, ref_type AS refType, ref_id AS refId, note, created_at AS createdAt FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
}

/**
 * Expiry sweep: warn ~72h before a lot expires (once), and debit expired
 * leftovers through `expire` ledger entries so the ledger/lots invariant holds.
 * Returns counts; SMS sending is left to the caller via the callback.
 */
export function runExpirySweep(db, notify = {}) {
  const nowMs = Date.now();
  let warned = 0, expired = 0;
  const soon = db.prepare(`SELECT l.*, u.phone FROM credit_lots l JOIN users u ON u.id = l.user_id
    WHERE l.tokens_left > 0 AND l.expires_at IS NOT NULL AND l.warned_at IS NULL
      AND l.expires_at > ? AND l.expires_at <= ?`).all(nowMs, nowMs + 72 * 3_600_000);
  for (const lot of soon) {
    db.prepare('UPDATE credit_lots SET warned_at = ? WHERE id = ?').run(nowMs, lot.id);
    notify.onWarning?.(lot);
    warned++;
  }
  const due = db.prepare('SELECT * FROM credit_lots WHERE tokens_left > 0 AND expires_at IS NOT NULL AND expires_at <= ?').all(nowMs);
  for (const lot of due) {
    tx(db, () => {
      const fresh = db.prepare('SELECT * FROM credit_lots WHERE id = ?').get(lot.id);
      if (!fresh || fresh.tokens_left <= 0) return;
      postLedger(db, {
        userId: fresh.user_id, kind: 'expire', deltaTokens: -fresh.tokens_left,
        refType: 'lot', refId: fresh.id, actor: 'system', meta: { lotSource: fresh.source },
      });
      db.prepare('UPDATE credit_lots SET tokens_left = 0 WHERE id = ?').run(fresh.id);
      notify.onExpired?.(fresh);
      expired++;
    });
  }
  return { warned, expired };
}
