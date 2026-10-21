import { tx, audit } from './db.js';
import { getPack } from './settings.js';
import { grantCredit } from './ledger.js';
import { badRequest, notFound, conflict } from './util.js';

/**
 * Card-to-card purchase — Liro-exact visible flow:
 *  user picks a pack → sees the shop card → transfers with their banking app →
 *  submits a claim {payerName, cardLast4, reference, paidAt?} → status pending →
 *  admin approves (entering the actually-received amount; partial credit if it
 *  differs) or rejects with a user-visible reason + internal note.
 * Approval is ONE atomic, idempotent transaction: a second review gets a 409
 * and can never double-credit.
 */

export const MAX_PENDING_PER_USER = 3;

export function createOrder(db, cfg, user, { packId, payerName, cardLast4, reference, paidAtText = null, paidAt = null }) {
  paidAtText = paidAtText ?? paidAt;
  const pack = getPack(db, cfg, packId);
  if (!pack) throw badRequest('pack_not_found', 'Unknown pack.');
  if (typeof payerName !== 'string' || payerName.trim().length < 2 || payerName.trim().length > 100)
    throw badRequest('invalid_payer_name', 'Payer name must be 2–100 characters.');
  if (!/^\d{4}$/.test(String(cardLast4 ?? ''))) throw badRequest('invalid_card_last4', 'Card last-4 must be exactly 4 digits.');
  if (typeof reference !== 'string' || reference.trim().length < 4 || reference.trim().length > 64)
    throw badRequest('invalid_reference', 'Tracking reference must be at least 4 characters.');
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND status = 'pending'").get(user.id);
  if (c >= MAX_PENDING_PER_USER) throw conflict('too_many_pending', 'You already have 3 pending payment claims. Wait for review.');

  const info = db.prepare(`INSERT INTO orders
    (user_id, pack_id, pack_title, tokens, price_rials, payer_name, card_last4, reference, paid_at_text, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, pack.id, pack.title, pack.tokens, pack.priceRials ?? 0,
    payerName.trim(), String(cardLast4), reference.trim(),
    paidAtText ? String(paidAtText).slice(0, 100) : null, Date.now());
  return getOrder(db, Number(info.lastInsertRowid));
}

export function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) ?? null;
}

export function listOrders(db, { status = null, limit = 100, offset = 0 } = {}) {
  const rows = status
    ? db.prepare(`SELECT o.*, u.phone AS user_phone FROM orders o JOIN users u ON u.id = o.user_id
                  WHERE o.status = ? ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(status, limit, offset)
    : db.prepare(`SELECT o.*, u.phone AS user_phone FROM orders o JOIN users u ON u.id = o.user_id
                  ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  return rows;
}

export function userOrders(db, userId, limit = 20) {
  return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

/**
 * Review an order. `receivedAmountRials` (approve only): if it differs from the
 * pack price, credit is granted proportionally (Liro semantics as briefed).
 * Returns { order, grantedTokens }.
 */
export function reviewOrder(db, cfg, adminPhone, orderId, { action, receivedAmountRials = null, reason = null, note = null }) {
  if (action !== 'approve' && action !== 'reject') throw badRequest('invalid_action', 'action must be approve|reject');
  if (note && String(note).length > 200) throw badRequest('note_too_long', 'Admin note max 200 chars.');
  if (action === 'reject' && !reason) throw badRequest('reason_required', 'Rejection requires a reason shown to the user.');

  const result = tx(db, () => {
    const order = getOrder(db, orderId);
    if (!order) throw notFound('order_not_found', 'Order not found.');
    if (order.status !== 'pending') throw conflict('already_reviewed', `Order already ${order.status}.`);

    if (action === 'approve') {
      let granted = order.tokens;
      const received = receivedAmountRials === null || receivedAmountRials === undefined ? order.price_rials : Number(receivedAmountRials);
      if (!Number.isFinite(received) || received < 0) throw badRequest('invalid_amount', 'Received amount is invalid.');
      if (order.price_rials > 0 && received !== order.price_rials) {
        granted = Math.floor(order.tokens * (received / order.price_rials));
      }
      const pack = getPack(db, cfg, order.pack_id);
      const validityDays = pack?.validityDays ?? null;
      const expiresAt = validityDays ? Date.now() + validityDays * 86_400_000 : null;
      db.prepare(`UPDATE orders SET status = 'approved', received_amount_rials = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
        .run(received, note, adminPhone, Date.now(), orderId);
      if (granted > 0) {
        grantCredit(db, {
          userId: order.user_id, tokens: granted, kind: 'purchase',
          refType: 'order', refId: order.id, actor: `admin:${adminPhone}`,
          note: note ?? null, expiresAt,
          meta: { packId: order.pack_id, expectedRials: order.price_rials, receivedRials: received },
          idempotencyKey: `order-approve:${order.id}`,
        });
      }
      audit(db, adminPhone, 'order_approved', `order:${order.id}`, { userId: order.user_id, grantedTokens: granted, receivedRials: received });
      return { order: getOrder(db, orderId), grantedTokens: granted };
    }

    db.prepare(`UPDATE orders SET status = 'rejected', reject_reason = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
      .run(String(reason).slice(0, 200), note, adminPhone, Date.now(), orderId);
    audit(db, adminPhone, 'order_rejected', `order:${order.id}`, { userId: order.user_id, reason: String(reason).slice(0, 200) });
    return { order: getOrder(db, orderId), grantedTokens: 0 };
  });
  return result;
}

export function publicOrder(o) {
  return {
    id: o.id, packId: o.pack_id, packTitle: o.pack_title, tokens: o.tokens,
    priceRials: o.price_rials, receivedAmountRials: o.received_amount_rials,
    payerName: o.payer_name, cardLast4: o.card_last4, reference: o.reference,
    paidAtText: o.paid_at_text, status: o.status,
    rejectReason: o.reject_reason, adminNote: o.admin_note,
    reviewedBy: o.reviewed_by, reviewedAt: o.reviewed_at, createdAt: o.created_at,
    ...(o.user_phone ? { userPhone: o.user_phone } : {}),
    ...(o.user_id ? { userId: o.user_id } : {}),
  };
}
