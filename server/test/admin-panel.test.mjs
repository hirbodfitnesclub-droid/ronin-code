import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startStack, req, loginUser, loginAdmin, grant, resetRateLimits, lastOtpFor, postClaim, ADMIN_PHONE,
} from './helpers.mjs';

/**
 * Admin panel additions (PRD §6): capability staff, refunds, finance console,
 * risk flags, devices, receipts, analyst. Same real stack as the ported suite
 * (Postgres + GoTrue), plus a local receipts dir and the fake upstream acting
 * as the analyst gateway.
 */

const STAFF_VIEW = '09123333333';   // caps: finance_view
const STAFF_WRITE = '09124444444';  // caps: expense_write
const USER2_PHONE = '09125555555';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

let stack, owner, user, user2, order, receiptsDir;
const today = () => new Date().toISOString().slice(0, 10);

async function loginAdminAs(phone) {
  await resetRateLimits(stack.db);
  const r1 = await req(stack.adminBase, '/admin-api/auth/otp/request', { method: 'POST', body: { phone } });
  assert.equal(r1.status, 200, `otp request for ${phone}: ${r1.text}`);
  const code = lastOtpFor(stack.sms, phone);
  const r2 = await req(stack.adminBase, '/admin-api/auth/otp/verify', { method: 'POST', body: { phone, code } });
  assert.equal(r2.status, 200, `otp verify for ${phone}: ${r2.text}`);
  const cookie = (r2.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, csrf: r2.json.csrfToken, phone, role: r2.json.role, caps: r2.json.caps };
}

const admin = (base, p, opts = {}) => req(base, p, opts);
const asOwner = (p, opts = {}) => admin(stack.adminBase, p, { cookie: owner.cookie, csrf: owner.csrf, ...opts });

before(async () => {
  receiptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-receipts-'));
  stack = await startStack({ cfg: { receiptsDir } });
  owner = await loginAdmin(stack);

  // Price pack-1 properly (test defaults carry priceRials 0): 500_000 rials, 1000 tokens.
  const packs = await asOwner('/admin-api/settings/packs', {
    method: 'PUT',
    body: { packs: [{ id: 'pack-1', title: 'بسته ۱ دلاری', usd: 1, priceRials: 500_000, validityDays: null, badge: null }] },
  });
  assert.equal(packs.status, 200, packs.text);

  user = await loginUser(stack);
  // Claim creation is receipt-only (multipart) on the merged backend.
  const created = await postClaim(stack.base, user.accessToken, 'pack-1');
  assert.equal(created.status, 201, created.text);
  order = created.json.order;

  const reviewed = await asOwner(`/admin-api/orders/${order.id}/review`, {
    method: 'POST', body: { action: 'approve', receivedAmountRials: 500_000 },
  });
  assert.equal(reviewed.status, 200, reviewed.text);
  assert.equal(reviewed.json.grantedTokens, 1000);
  order = reviewed.json.order;
});

after(async () => {
  await stack.close();
  fs.rmSync(receiptsDir, { recursive: true, force: true });
});

test('receipt: admin serves the stored image; duplicate hash is flagged in the queue', async () => {
  // A second user files a claim reusing the SAME receipt image (setup via SQL —
  // the claim-creation side belongs to the user-panel rework; the admin side
  // only reads receipt_path/image_sha256).
  user2 = await loginUser(stack, USER2_PHONE);
  const c2 = await postClaim(stack.base, user2.accessToken, 'pack-1');
  assert.equal(c2.status, 201, c2.text);
  fs.writeFileSync(path.join(receiptsDir, 'shared.png'), PNG_1PX);
  await stack.db.query('UPDATE public.orders SET receipt_path = $2, image_sha256 = $3 WHERE id = $1',
    [order.id, 'shared.png', 'sha-shared']);
  await stack.db.query('UPDATE public.orders SET receipt_path = $2, image_sha256 = $3 WHERE id = $1',
    [c2.json.order.id, 'shared.png', 'sha-shared']);

  const queue = await asOwner('/admin-api/orders?status=pending');
  assert.equal(queue.status, 200);
  const dup = queue.json.orders.find((o) => o.id === c2.json.order.id);
  assert.equal(dup.hasReceipt, true);
  assert.equal(dup.duplicateReceipt, true);

  const all = await asOwner('/admin-api/orders');
  const approved = all.json.orders.find((o) => o.id === order.id);
  assert.equal(approved.duplicateReceipt, true);

  const img = await fetch(`${stack.adminBase}/admin-api/orders/${order.id}/receipt`, {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.deepEqual(bytes, PNG_1PX);
});

test('refund: partial is proportional + idempotent; over-refund blocked; full refund flips status', async () => {
  const key1 = 'refund-key-1';
  const r1 = await asOwner(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 250_000, reason: 'اشتباه در واریز', reference: 'BANK-1', idempotencyKey: key1 },
  });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.tokensRemoved, 500); // half of 1000 tokens
  assert.equal(r1.json.replayed, false);

  const me = await req(stack.base, '/api/me', { token: user.accessToken });
  assert.equal(me.json.balanceTokens, 500);

  const replay = await asOwner(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 250_000, reason: 'اشتباه در واریز', idempotencyKey: key1 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  const me2 = await req(stack.base, '/api/me', { token: user.accessToken });
  assert.equal(me2.json.balanceTokens, 500); // unchanged

  const over = await asOwner(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 250_001, reason: 'بیش از دریافتی', idempotencyKey: 'refund-key-2' },
  });
  assert.equal(over.status, 400);
  assert.equal(over.json.error.code, 'exceeds_received');

  const r2 = await asOwner(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 250_000, reason: 'بازگشت کامل', idempotencyKey: 'refund-key-3' },
  });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.order.status, 'refunded');
  const me3 = await req(stack.base, '/api/me', { token: user.accessToken });
  assert.equal(me3.json.balanceTokens, 0);

  const afterFull = await asOwner(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 1, reason: 'دیگر نباید بشود', idempotencyKey: 'refund-key-4' },
  });
  assert.equal(afterFull.status, 409);
});

test('caps: staff login works; every route enforces capabilities server-side', async () => {
  const put = await asOwner('/admin-api/settings/finance-staff', {
    method: 'PUT',
    body: {
      staff: [
        { phone: STAFF_VIEW, caps: ['finance_view'] },
        { phone: STAFF_WRITE, caps: ['expense_write'] },
      ],
    },
  });
  assert.equal(put.status, 200, put.text);

  const viewer = await loginAdminAs(STAFF_VIEW);
  assert.equal(viewer.role, 'staff');
  assert.deepEqual(viewer.caps, ['finance_view']);
  const asViewer = (p, opts = {}) => admin(stack.adminBase, p, { cookie: viewer.cookie, csrf: viewer.csrf, ...opts });

  assert.equal((await asViewer('/admin-api/overview')).status, 200);
  assert.equal((await asViewer('/admin-api/finance/expenses')).status, 200);
  assert.equal((await asViewer('/admin-api/users')).status, 403); // no finance_user
  assert.equal((await asViewer('/admin-api/finance/expenses', {
    method: 'POST', body: { amountRials: 1000, category: 'x' },
  })).status, 403); // no expense_write
  const review = await asViewer(`/admin-api/orders/${order.id}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(review.status, 403); // approval is owner-only
  assert.equal(review.json.error.code, 'owner_required');
  assert.equal((await asViewer(`/admin-api/orders/${order.id}/refund`, {
    method: 'POST', body: { amountRials: 1, reason: 'تست تست', idempotencyKey: 'staff-refund' },
  })).status, 403); // no refund_write
  assert.equal((await asViewer('/admin-api/audit')).status, 403); // audit is owner-only
  assert.equal((await asViewer('/admin-api/settings/finance-staff', {
    method: 'PUT', body: { staff: [] },
  })).status, 403);

  const writer = await loginAdminAs(STAFF_WRITE);
  const asWriter = (p, opts = {}) => admin(stack.adminBase, p, { cookie: writer.cookie, csrf: writer.csrf, ...opts });
  assert.equal((await asWriter('/admin-api/finance/expenses', {
    method: 'POST', body: { amountRials: 42_000, category: 'ابزار', spentOn: today() },
  })).status, 201);
  assert.equal((await asWriter('/admin-api/finance/expenses')).status, 403); // no finance_view
  assert.equal((await asWriter('/admin-api/finance/export.csv')).status, 403); // no export
  assert.equal((await asWriter('/admin-api/overview')).status, 403);
});

test('finance: expenses CRUD, P&L by period, export', async () => {
  const exp = await asOwner('/admin-api/finance/expenses', {
    method: 'POST', body: { amountRials: 120_000, category: 'سرور', note: 'VPS ماهانه', spentOn: today() },
  });
  assert.equal(exp.status, 201, exp.text);
  const expenseId = exp.json.expense.id;

  const period = await asOwner('/admin-api/finance/periods', {
    method: 'POST', body: { title: 'امروز', startsOn: today(), endsOn: today() },
  });
  assert.equal(period.status, 201, period.text);

  const pnlRes = await asOwner(`/admin-api/finance/pnl?periodId=${period.json.period.id}`);
  assert.equal(pnlRes.status, 200, pnlRes.text);
  // income 500_000 (one approval) − refunds 500_000 (test above) − expenses 162_000 (120_000 + staff's 42_000)
  assert.equal(pnlRes.json.pnl.incomeRials, 500_000);
  assert.equal(pnlRes.json.pnl.refundRials, 500_000);
  assert.equal(pnlRes.json.pnl.expenseRials, 162_000);
  assert.equal(pnlRes.json.pnl.netRials, -162_000);

  const upd = await asOwner(`/admin-api/finance/expenses/${expenseId}`, {
    method: 'PUT', body: { amountRials: 130_000, category: 'سرور', note: 'اصلاح شد', spentOn: today() },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.expense.amountRials, 130_000);
  const del = await asOwner(`/admin-api/finance/expenses/${expenseId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  const close = await asOwner(`/admin-api/finance/periods/${period.json.period.id}/close`, { method: 'POST', body: {} });
  assert.equal(close.status, 200);
  assert.ok(close.json.period.closedAt);

  const csv = await fetch(`${stack.adminBase}/admin-api/finance/export.csv?from=${today()}&to=${today()}`, {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /income/);
  assert.match(text, /refund/);
});

test('dossier extras: devices list + revoke, risk flags lifecycle', async () => {
  const devs = await asOwner(`/admin-api/users/${user.user.id}/devices`);
  assert.equal(devs.status, 200);
  assert.equal(devs.json.devices.length, 1);
  assert.equal(devs.json.devices[0].active, true);

  const revoke = await asOwner(`/admin-api/users/${user.user.id}/devices/${devs.json.devices[0].id}/revoke`, {
    method: 'POST', body: {},
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.json.devices[0].active, false);

  const flag = await asOwner(`/admin-api/users/${user.user.id}/risk-flags`, {
    method: 'POST', body: { kind: 'sharing_suspected', note: 'دو شهر متفاوت در یک روز' },
  });
  assert.equal(flag.status, 201, flag.text);
  const list = await asOwner(`/admin-api/users/${user.user.id}/risk-flags`);
  assert.equal(list.json.flags.length, 1);
  const resolved = await asOwner(`/admin-api/risk-flags/${flag.json.flag.id}/resolve`, { method: 'POST', body: {} });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.flag.status, 'resolved');

  const detail = await asOwner(`/admin-api/users/${user.user.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.openRiskFlags, 0);
});

test('analyst: answers from gateway with server-side key; audit written', async () => {
  const r = await asOwner('/admin-api/analyst/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'چند کاربر داریم؟' }] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.reply, 'salam'); // the fake upstream's canned completion
  const auditRes = await asOwner('/admin-api/audit?action=analyst_asked');
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.json.total >= 1);
  assert.ok(auditRes.json.audit.every((a) => a.action === 'analyst_asked'));
});

test('settings: model disable blocks the proxy; token config carries the daily Rial rate', async () => {
  await grant(stack, user.user.id, 5000);
  const models = await asOwner('/admin-api/settings/models', {
    method: 'PUT', body: { models: [{ model: 'gpt-4o', multiplier: 2, enabled: false }] },
  });
  assert.equal(models.status, 200, models.text);
  const freshUser = await loginUser(stack, '09126666666');
  await grant(stack, freshUser.user.id, 5000);
  const blocked = await req(stack.base, '/v1/chat/completions', {
    method: 'POST', token: freshUser.accessToken,
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'model_disabled');

  const tc = await asOwner('/admin-api/settings/token-config', {
    method: 'PUT', body: { tokensPerUsd: 1000, defaultMultiplier: 1, usdRialRate: 900_000 },
  });
  assert.equal(tc.status, 200);
  assert.equal(tc.json.tokenConfig.usdRialRate, 900_000);
});
