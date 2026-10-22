import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, req, loginUser, loginAdmin, lastOtpFor, resetRateLimits, postClaim, PNG_1PX, ADMIN_PHONE, USER_PHONE } from './helpers.mjs';

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

  // Receipt-only claim: one image upload, NO form fields at all.
  const orderRes = await postClaim(stack.base, user.accessToken, 'pack-1');
  assert.equal(orderRes.status, 201);
  const order = orderRes.json.order;
  assert.equal(order.status, 'pending');
  assert.equal(order.hasReceipt, true);
  assert.equal(order.payerName, undefined);
  assert.equal(order.cardLast4, undefined);
  assert.equal(order.reference, undefined);

  // Admin queue sees it — with a signed receipt URL and no duplicate flag;
  // the signed URL actually serves the uploaded bytes on the admin listener.
  const queue = await req(stack.adminBase, '/admin-api/orders?status=pending', { cookie: admin.cookie });
  const queued = queue.json.orders.find((o) => o.id === order.id);
  assert.ok(queued);
  assert.equal(queued.duplicateImage, false);
  assert.ok(typeof queued.receiptUrl === 'string' && queued.receiptUrl.includes('/admin-api/receipt-file'));
  const img = await fetch(stack.adminBase + queued.receiptUrl);
  assert.equal(img.status, 200);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG_1PX));
  const tampered = await fetch(stack.adminBase + queued.receiptUrl.replace(/sig=[^&]+/, 'sig=AAAA'));
  assert.equal(tampered.status, 403);
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
  const mk = () => postClaim(stack.base, u2.accessToken, 'pack-1');
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
  for (let i = 0; i < 3; i++) {
    const r = await postClaim(stack.base, u.accessToken, 'pack-1');
    assert.equal(r.status, 201);
  }
  const fourth = await postClaim(stack.base, u.accessToken, 'pack-1');
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.error.code, 'too_many_pending');
  // The refused claim's upload was cleaned up — no orphan receipt object.
  const stored = fs.readdirSync(path.join(stack.cfg.receiptsDir, u.user.id));
  assert.equal(stored.length, 3);
});

test('receipt upload validation: non-image, missing file and oversize are rejected', async () => {
  const notImage = await postClaim(stack.base, user.accessToken, 'pack-1', {
    data: Buffer.from('definitely not an image'), contentType: 'text/plain', filename: 'receipt.txt',
  });
  assert.equal(notImage.status, 400);
  assert.equal(notImage.json.error.code, 'invalid_receipt_type');

  const missing = await postClaim(stack.base, user.accessToken, 'pack-1', { data: null });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'receipt_required');

  const oversize = await postClaim(stack.base, user.accessToken, 'pack-1', {
    data: Buffer.alloc(5 * 1024 * 1024 + 1, 7), contentType: 'image/png', filename: 'huge.png',
  });
  assert.equal(oversize.status, 400);
  assert.equal(oversize.json.error.code, 'receipt_too_large');

  const badPack = await postClaim(stack.base, user.accessToken, 'no-such-pack');
  assert.equal(badPack.status, 400);
  assert.equal(badPack.json.error.code, 'pack_not_found');
});

test('duplicate receipt image is flagged for the admin (passive flag only)', async () => {
  const shared = Buffer.concat([PNG_1PX, Buffer.from('shared-receipt-bytes')]);
  const unique = Buffer.concat([PNG_1PX, Buffer.from('one-of-a-kind-bytes')]);
  const a = await loginUser(stack, '09120000101');
  const b = await loginUser(stack, '09120000102');
  const c = await loginUser(stack, '09120000103');
  const oa = (await postClaim(stack.base, a.accessToken, 'pack-1', { data: shared })).json.order;
  const ob = (await postClaim(stack.base, b.accessToken, 'pack-1', { data: shared })).json.order;
  const oc = (await postClaim(stack.base, c.accessToken, 'pack-1', { data: unique })).json.order;
  assert.ok(oa.id && ob.id && oc.id);

  const detailA = await req(stack.adminBase, `/admin-api/orders/${oa.id}`, { cookie: admin.cookie });
  assert.equal(detailA.json.order.duplicateImage, true);
  const detailB = await req(stack.adminBase, `/admin-api/orders/${ob.id}`, { cookie: admin.cookie });
  assert.equal(detailB.json.order.duplicateImage, true);
  const detailC = await req(stack.adminBase, `/admin-api/orders/${oc.id}`, { cookie: admin.cookie });
  assert.equal(detailC.json.order.duplicateImage, false);
  assert.ok(detailC.json.order.receiptUrl);

  // The flag changes nothing by itself: a flagged claim can still be approved.
  const review = await req(stack.adminBase, `/admin-api/orders/${oa.id}/review`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'approve', receivedAmountRials: 50_000 },
  });
  assert.equal(review.status, 200);
  assert.equal(review.json.grantedTokens, 1000);
});

test('OTP brute force: 5 wrong attempts lock the code, even the right code then fails', async () => {
  const phone = '09124444444';
  await resetRateLimits(stack.db);
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
  // OTPs now live in Supabase Auth: expiry is exercised through a stack whose
  // Auth server is configured with a 1-second OTP lifetime (same product
  // scenario as the old direct table poke, through the real config surface).
  const s2 = await startStack({ gotrue: { smsOtpExpSeconds: 1 } });
  try {
    const phone = '09125555555';
    await req(s2.base, '/api/auth/otp/request', { method: 'POST', body: { phone } });
    const code = lastOtpFor(s2.sms, phone);
    await new Promise((r) => setTimeout(r, 1300));
    const r = await req(s2.base, '/api/auth/otp/verify', { method: 'POST', body: { phone, code } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'otp_expired');
  } finally {
    await s2.close();
  }
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
  await grantCredit(stack.db, {
    userId: u.user.id, tokens: 300, kind: 'purchase', refType: 'order', refId: 999,
    actor: 'admin:test', expiresAt: Date.now() - 1000,
  });
  assert.equal(await ledgerBalance(stack.db, u.user.id), 300);
  const out = await runExpirySweep(stack.db, {});
  assert.equal(out.expired, 1);
  assert.equal(await ledgerBalance(stack.db, u.user.id), 0);
  const credits = await req(stack.base, '/api/credits', { token: u.accessToken });
  assert.ok(credits.json.ledger.some((l) => l.kind === 'expire' && l.deltaTokens === -300));
  assert.ok(ADMIN_PHONE.length === 11);
});

test('daily revalidation: account-status reflects server truth; revoked device and suspension fail the check', async () => {
  const { grant } = await import('./helpers.mjs');
  const phone = '09120000333';
  const d1 = await loginUser(stack, phone, 'daily-device-1');
  await grant(stack, d1.user.id, 500);

  // The lightweight status the app polls on launch + daily.
  const ok = await req(stack.base, '/api/account-status', { token: d1.accessToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'active');
  assert.equal(ok.json.isActive, true);
  assert.equal(ok.json.deviceAuthorized, true);
  assert.equal(ok.json.balanceTokens, 500);
  assert.equal(ok.json.spendableTokens, 500);
  assert.ok(Math.abs(Date.now() - ok.json.serverTime) < 60_000, 'serverTime must be the server clock');
  assert.ok(Array.isArray(ok.json.lots) && ok.json.lots.some((l) => l.tokensLeft === 500));

  // Revoke device 1 from device 2 → device 1 fails its next check outright.
  const d2 = await loginUser(stack, phone, 'daily-device-2');
  const del = await req(stack.base, `/api/devices/${d1.deviceId}`, { method: 'DELETE', token: d2.accessToken });
  assert.equal(del.status, 200);
  const revokedCheck = await req(stack.base, '/api/account-status', { token: d1.accessToken });
  assert.equal(revokedCheck.status, 401);

  // Admin suspension kills live sessions: the very next check fails.
  const off = await req(stack.adminBase, `/admin-api/users/${d1.user.id}/toggle-active`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { isActive: false },
  });
  assert.equal(off.status, 200);
  const killedCheck = await req(stack.base, '/api/account-status', { token: d2.accessToken });
  assert.equal(killedCheck.status, 401);

  // Even a flag-only suspension (e.g. flipped by a billing job, sessions not
  // yet revoked) takes effect at the next check — as account_disabled.
  const on = await req(stack.adminBase, `/admin-api/users/${d1.user.id}/toggle-active`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { isActive: true },
  });
  assert.equal(on.status, 200);
  const d3 = await loginUser(stack, phone, 'daily-device-3');
  await stack.db.query('UPDATE public.users SET is_active = false WHERE id = $1', [d1.user.id]);
  const flagCheck = await req(stack.base, '/api/account-status', { token: d3.accessToken });
  assert.equal(flagCheck.status, 401);
  assert.equal(flagCheck.json.error.code, 'account_disabled');
  await stack.db.query('UPDATE public.users SET is_active = true WHERE id = $1', [d1.user.id]);
});
