import { getPack } from './settings.js';
import { badRequest, notFound, conflict, num, ms } from './util.js';
import { receiptKey, sha256Hex } from './storage.js';

/**
 * Card-to-card purchase — RECEIPT PHOTO ONLY (owner decision 2026-10-22,
 * superseding the Liro form-field claim):
 *  user picks a pack → sees the shop card → transfers with their banking app →
 *  uploads ONE receipt image → claim is `pending` (pack price/token snapshot
 *  locked in the row) → the owner personally reviews the image in the admin
 *  panel → approve (entering the actually-received amount; partial credit if
 *  it differs) or reject with a user-visible reason + internal note.
 * There are NO claim form fields. The image's SHA-256 is stored so the admin
 * list/detail can flag `duplicateReceipt` when the same photo appears on
 * more than one claim — a passive flag only; the human decides.
 * Approval is ONE atomic, idempotent RPC (approve_claim): a second review
 * gets a 409 and can never double-credit.
 */

export const MAX_PENDING_PER_USER = 3;

/**
 * Create a claim from an uploaded receipt image { data: Buffer, contentType }.
 * Validates the upload (image/* only, ≤ cfg.receiptMaxBytes), stores the
 * object under the caller's own prefix, then calls the create_claim RPC.
 * If the RPC refuses the claim (e.g. too many pending), the just-stored
 * object is removed again so storage never accumulates orphans.
 */
export async function createOrder(db, cfg, storage, user, { packId, receipt }) {
  const pack = await getPack(db, cfg, packId);
  if (!pack) throw badRequest('pack_not_found', 'Unknown pack.');
  if (!receipt || !receipt.data?.length) throw badRequest('receipt_required', 'A receipt image is required.');
  const contentType = String(receipt.contentType || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw badRequest('invalid_receipt_type', 'The receipt must be an image file.');
  }
  if (receipt.data.length > cfg.receiptMaxBytes) {
    throw badRequest('receipt_too_large', `The receipt image must be at most ${Math.floor(cfg.receiptMaxBytes / (1024 * 1024))} MB.`);
  }

  const imageSha256 = sha256Hex(receipt.data);
  const key = receiptKey(user.id, contentType);
  await storage.put(key, receipt.data, contentType);
  try {
    const row = await db.one(
      'SELECT public.create_claim($1,$2,$3,$4,$5,$6,$7) AS r',
      [user.id, pack.id, pack.title, pack.tokens, pack.priceRials ?? 0, key, imageSha256]);
    const r = row.r;
    if (!r.ok) {
      if (r.error === 'too_many_pending') {
        throw conflict('too_many_pending', `You already have ${MAX_PENDING_PER_USER} pending payment claims. Wait for review.`);
      }
      if (r.error === 'receipt_required') throw badRequest('receipt_required', 'A receipt image is required.');
      throw new Error(`create_claim failed: ${r.error}`);
    }
    return r.order;
  } catch (e) {
    await storage.remove(key).catch(() => {});
    throw e;
  }
}

export async function getOrder(db, id) {
  return (await db.one('SELECT * FROM public.orders WHERE id = $1', [id])) ?? null;
}

export async function listOrders(db, { status = null, limit = 100, offset = 0 } = {}) {
  return status
    ? db.many(`SELECT o.*, u.phone AS user_phone FROM public.orders o JOIN public.users u ON u.id = o.user_id
               WHERE o.status = $1 ORDER BY o.id DESC LIMIT $2 OFFSET $3`, [status, limit, offset])
    : db.many(`SELECT o.*, u.phone AS user_phone FROM public.orders o JOIN public.users u ON u.id = o.user_id
               ORDER BY o.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
}

export async function userOrders(db, userId, limit = 20) {
  return db.many('SELECT * FROM public.orders WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [userId, limit]);
}

/**
 * Review an order. `receivedAmountRials` (approve only): if it differs from the
 * pack price, credit is granted proportionally. All money movement happens
 * inside the approve/reject RPC — atomically.
 * Returns { order, grantedTokens }.
 */
export async function reviewOrder(db, cfg, adminPhone, orderId, { action, receivedAmountRials = null, reason = null, note = null }) {
  if (action !== 'approve' && action !== 'reject') throw badRequest('invalid_action', 'action must be approve|reject');
  if (note && String(note).length > 200) throw badRequest('note_too_long', 'Admin note max 200 chars.');
  if (action === 'reject' && !reason) throw badRequest('reason_required', 'Rejection requires a reason shown to the user.');

  const existing = await getOrder(db, orderId);
  if (!existing) throw notFound('order_not_found', 'Order not found.');

  if (action === 'approve') {
    let received = null;
    if (receivedAmountRials !== null && receivedAmountRials !== undefined) {
      received = Number(receivedAmountRials);
      if (!Number.isFinite(received) || received < 0) throw badRequest('invalid_amount', 'Received amount is invalid.');
    }
    const pack = await getPack(db, cfg, existing.pack_id);
    const row = await db.one(
      'SELECT public.approve_claim($1,$2,$3,$4,$5) AS r',
      [orderId, adminPhone, received, note, pack?.validityDays ?? null]);
    const r = row.r;
    if (!r.ok) {
      if (r.error === 'already_reviewed') throw conflict('already_reviewed', `Order already ${r.status}.`);
      if (r.error === 'invalid_amount') throw badRequest('invalid_amount', 'Received amount is invalid.');
      throw new Error(`approve_claim failed: ${r.error}`);
    }
    return { order: r.order, grantedTokens: Number(r.grantedTokens) };
  }

  const row = await db.one(
    'SELECT public.reject_claim($1,$2,$3,$4) AS r',
    [orderId, adminPhone, String(reason).slice(0, 200), note]);
  const r = row.r;
  if (!r.ok) {
    if (r.error === 'already_reviewed') throw conflict('already_reviewed', `Order already ${r.status}.`);
    throw new Error(`reject_claim failed: ${r.error}`);
  }
  return { order: r.order, grantedTokens: 0 };
}

export function publicOrder(o, extras = {}) {
  return {
    id: Number(o.id), packId: o.pack_id, packTitle: o.pack_title, tokens: num(o.tokens),
    priceRials: num(o.price_rials), receivedAmountRials: num(o.received_amount_rials),
    hasReceipt: Boolean(o.receipt_path),
    status: o.status,
    rejectReason: o.reject_reason, adminNote: o.admin_note,
    reviewedBy: o.reviewed_by, reviewedAt: ms(o.reviewed_at), createdAt: ms(o.created_at),
    ...(o.user_phone ? { userPhone: o.user_phone } : {}),
    ...(o.user_id ? { userId: o.user_id } : {}),
    ...extras,
  };
}

