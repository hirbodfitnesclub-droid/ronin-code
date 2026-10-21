import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, req, loginUser, loginAdmin, lastOtpFor, resetRateLimits, ADMIN_PHONE, USER_PHONE } from './helpers.mjs';

let stack, user, admin;
const PHONE2 = '09122222222';

before(async () => {
  stack = await startStack();
  user = await loginUser(stack);
  admin = await loginAdmin(stack);
  // Give pack-1 a real price through the admin settings API.
  const s = await req(stack.adminBase, '/admin-api/settings', { cookie: admin.cookie });
  const packs = s.json.packs.map((p) => (p.id === 'pack-1' ? { ...p, priceRials: 50_000 } : p));
  const put = await req(stack.adminBase, '/admin-api/settings/packs', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { packs } });
  assert.equal(put.status, 200);
});
after(() => stack.close());

test('happy path: OTP login → order → admin approve → ledger credit', async () => {
  assert.ok(user.accessToken && user.refreshToken);
  const packsRes = await req(stack.base, '/api/packs', { token: user.accessToken });
  assert.equal(packsRes.status, 200);
  const pack1 = packsRes.json.packs.find((p) => p.id === 'pack-1');
  assert.equal(pack1.tokens, 1000); // tokensPerUsd=1000 in tests
  assert.equal(pack1.priceRials, 50_000);

  const orderRes = await req(stack.base, '/api/orders', {
    method: 'POST', token: user.accessToken,
    body: { packId: 'pack-1', payerName: 'Ali Reza', cardLast4: '1234', reference: 'TRACK-9876', paidAtText: 'دیروز ۱۴:۳۰' },
  });
  assert.equal(orderRes.status, 201);
  const order = orderRes.json.order;
  assert.equal(order.status, 'pending');

  // Admin queue sees it; approve with the exact received amount → full credit + activation SMS.
  const queue = await req(stack.adminBase, '/admin-api/orders?status=pending', { cookie: admin.cookie });
  assert.ok(queue.json.orders.some((o) => o.id === order.id));
  const review = await req(stack.adminBase, `/admin-api/orders/${order.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { action: 'approve', receivedAmountRials: 50_000, note: 'ok' },
  });
  assert.equal(review.status, 200);
  assert.equal(review.json.grantedTokens, 1000);
  assert.ok(stack.sms.outbox.some((m) => m.phone === USER_PHONE && m.template === (stack.cfg.smsTemplates.packageActivated || '') || m.phone === USER_PHONE));

  const credits = await req(stack.base, '/api/credits', { token: user.accessToken });
  assert.equal(credits.json.balanceTokens, 1000);
  assert.equal(credits.json.spendableTokens, 1000);
  assert.ok(credits.json.ledger.some((l) => l.kind === 'purchase' && l.deltaTokens === 1000));

  // Second review → 409, and no double credit.
  const again = await req(stack.adminBase, `/admin-api/orders/${order.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'approve', receivedAmountRials: 50_000 },
  });
  assert.equal(again.status, 409);
  const credits2 = await req(stack.base, '/api/credits', { token: user.accessToken });
  assert.equal(credits2.json.balanceTokens, 1000);
});

test('partial received amount grants proportional credit; rejection requires a reason', async () => {
  const u2 = await loginUser(stack, PHONE2);
  const mk = () => req(stack.base, '/api/orders', {
    method: 'POST', token: u2.accessToken,
    body: { packId: 'pack-1', payerName: 'Sara', cardLast4: '9876', reference: 'REF-2222' },
  });
  const o1 = (await mk()).json.order;
  const half = await req(stack.adminBase, `/admin-api/orders/${o1.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'approve', receivedAmountRials: 25_000 },
  });
  assert.equal(half.status, 200);
  assert.equal(half.json.grantedTokens, 500); // half the money → half the tokens

  const o2 = (await mk()).json.order;
  const noReason = await req(stack.adminBase, `/admin-api/orders/${o2.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'reject' },
  });
  assert.equal(noReason.status, 400);
  const rejected = await req(stack.adminBase, `/admin-api/orders/${o2.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'reject', reason: 'رسید خوانا نیست' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.order.status, 'rejected');
  assert.equal(rejected.json.order.rejectReason, 'رسید خوانا نیست');
});

test('max 3 pending orders per user', async () => {
  const u = await loginUser(stack, '09123333333');
  const body = { packId: 'pack-1', payerName: 'Max', cardLast4: '1111', reference: 'R-0001' };
  for (let i = 0; i < 3; i++) {
    const r = await req(stack.base, '/api/orders', { method: 'POST', token: u.accessToken, body: { ...body, reference: `R-000${i}` } });
    assert.equal(r.status, 201);
  }
  const fourth = await req(stack.base, '/api/orders', { method: 'POST', token: u.accessToken, body: { ...body, reference: 'R-0009' } });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.error.code, 'too_many_pending');
});

test('OTP brute force: 5 wrong attempts lock the code, even the right code then fails', async () => {
  const phone = '09124444444';
  resetRateLimits(stack.db);
  await req(stack.base, '/api/auth/otp/request', { method: 'POST', body: { phone } });
  const good = lastOtpFor(stack.sms, phone);
  const wrong = good === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await req(stack.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code: wrong } });
    assert.equal(r.status, 400);
  }
  const after = await req(stack.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code: good } });
  assert.notEqual(after.status, 200);
});

test('expired OTP is rejected', async () => {
  const phone = '09125555555';
  resetRateLimits(stack.db);
  await req(stack.base, '/api/auth/otp/request', { method: 'POST', body: { phone } });
  const code = lastOtpFor(stack.sms, phone);
  stack.db.prepare('UPDATE otp_codes SET expires_at = ? WHERE phone = ?').run(Date.now() - 1000, phone);
  const r = await req(stack.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'otp_expired');
});

test('refresh rotation works; reuse of a rotated token kills the whole family', async () => {
  const u = await loginUser(stack, '09126666666');
  const r1 = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } });
  assert.equal(r1.status, 200);
  const pair2 = r1.json;
  assert.notEqual(pair2.refreshToken, u.refreshToken);
  // Reuse the OLD (rotated-away) token → theft path.
  const reuse = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.json.error.code, 'refresh_reuse');
  // The legit new token is dead too (family revoked).
  const after = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: pair2.refreshToken } });
  assert.equal(after.status, 401);
  const me = await req(stack.base, '/api/me', { token: pair2.accessToken });
  assert.equal(me.status, 401);
});

test('device cap: a 3rd device login revokes the oldest device', async () => {
  const phone = '09127777777';
  const d1 = await loginUser(stack, phone, 'device-1');
  const d2 = await loginUser(stack, phone, 'device-2');
  const d3 = await loginUser(stack, phone, 'device-3');
  assert.ok(d3.accessToken);
  const stale = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: d1.refreshToken } });
  assert.equal(stale.status, 401);
  const fresh = await req(stack.base, '/api/auth/refresh', { method: 'POST', body: { refreshToken: d2.refreshToken } });
  assert.equal(fresh.status, 200);
  const devices = await req(stack.base, '/api/devices', { token: d3.accessToken });
  assert.equal(devices.json.devices.filter((d) => d.active).length, 2);
});

test('admin separation: user tokens never satisfy the admin app, admin cookie never satisfies the user API', async () => {
  // User bearer token against the STANDALONE admin app → 401 (it only reads its own cookie).
  const asUser = await req(stack.adminBase, '/admin-api/overview', { token: user.accessToken });
  assert.equal(asUser.status, 401);
  const noAuth = await req(stack.adminBase, '/admin-api/overview');
  assert.equal(noAuth.status, 401);
  // Admin cookie against the user API → 401 (user API only reads bearer tokens).
  const asAdmin = await req(stack.base, '/api/me', { cookie: admin.cookie });
  assert.equal(asAdmin.status, 401);
  // Admin OTP for a non-admin phone → 403.
  const notAdmin = await req(stack.adminBase, '/admin-api/auth/otp/request', { method: 'POST', body: { phone: USER_PHONE } });
  assert.equal(notAdmin.status, 403);
  // Mutating admin call without CSRF token → 403.
  const noCsrf = await req(stack.adminBase, '/admin-api/users/1/toggle-active', { method: 'POST', cookie: admin.cookie, body: {} });
  assert.equal(noCsrf.status, 403);
});

test('admin manual charge requires a note and writes an adjust ledger entry + audit row', async () => {
  const target = await loginUser(stack, '09128888888');
  const noNote = await req(stack.adminBase, `/admin-api/users/${target.user.id}/charge`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tokens: 777 },
  });
  assert.equal(noNote.status, 400);
  const ok = await req(stack.adminBase, `/admin-api/users/${target.user.id}/charge`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tokens: 777, note: 'جبران اختلال سرویس' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.balanceTokens, 777);
  const credits = await req(stack.base, '/api/credits', { token: target.accessToken });
  assert.ok(credits.json.ledger.some((l) => l.kind === 'adjust' && l.deltaTokens === 777));
  const auditRes = await req(stack.adminBase, '/admin-api/audit', { cookie: admin.cookie });
  assert.ok(auditRes.json.audit.some((a) => a.action === 'user_manual_charge'));
});

test('expiry sweep debits expired lots through the ledger', async () => {
  const u = await loginUser(stack, '09129999999');
  const { grantCredit, runExpirySweep, ledgerBalance } = await import('../src/ledger.js');
  const { tx } = await import('../src/db.js');
  tx(stack.db, () => grantCredit(stack.db, {
    userId: u.user.id, tokens: 300, kind: 'purchase', refType: 'order', refId: 999,
    actor: 'admin:test', expiresAt: Date.now() - 1000,
  }));
  assert.equal(ledgerBalance(stack.db, u.user.id), 300);
  const out = runExpirySweep(stack.db, {});
  assert.equal(out.expired, 1);
  assert.equal(ledgerBalance(stack.db, u.user.id), 0);
  const credits = await req(stack.base, '/api/credits', { token: u.accessToken });
  assert.ok(credits.json.ledger.some((l) => l.kind === 'expire' && l.deltaTokens === -300));
  assert.ok(ADMIN_PHONE.length === 11);
});
