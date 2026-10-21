import http from 'node:http';
import { createRouter, withErrorHandling, sendJson, readJson, bearer, clientIp } from './http.js';
import { normalizePhone, badRequest, forbidden, notFound } from './util.js';
import { isAdminPhone } from './util.js';
import * as auth from './auth.js';
import { getPacks, getCard, getModels } from './settings.js';
import { ledgerBalance, spendableTokens, userLedger } from './ledger.js';
import { createOrder, userOrders, publicOrder } from './orders.js';
import { handleChatCompletions } from './proxy.js';

/** User API application (no admin surface here at all — the admin is a separate app). */
export function createUserApp(db, cfg, sms) {
  const router = createRouter();
  const requireUser = (req) => auth.authenticate(db, bearer(req));

  router.post('/api/auth/otp/request', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid Iranian mobile number (09xxxxxxxxx).');
    await auth.requestOtp(db, cfg, sms, { phone, purpose: 'login', ip: clientIp(req) });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/auth/otp/verify', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone || !body.code) throw badRequest('invalid_input', 'phone and code are required.');
    const out = auth.loginWithOtp(db, cfg, {
      phone, code: String(body.code),
      deviceName: body.deviceName ? String(body.deviceName).slice(0, 80) : null,
      name: body.name ? String(body.name).slice(0, 80) : null,
    });
    sendJson(res, 200, {
      accessToken: out.accessToken, refreshToken: out.refreshToken,
      accessExpiresInSec: Math.floor(auth.ACCESS_TTL_MS / 1000),
      user: out.user, deviceId: out.deviceId,
    });
  });

  router.post('/api/auth/refresh', async (req, res) => {
    const body = await readJson(req);
    const out = auth.refreshSession(db, body.refreshToken);
    sendJson(res, 200, { accessToken: out.accessToken, refreshToken: out.refreshToken, user: out.user });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const { user, familyId } = requireUser(req);
    auth.revokeFamily(db, familyId, 'logout');
    void user;
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/auth/logout-all', async (req, res) => {
    const { user } = requireUser(req);
    auth.logoutAll(db, user.id);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/devices', async (req, res) => {
    const { user } = requireUser(req);
    sendJson(res, 200, { devices: auth.listDevices(db, user.id) });
  });

  router.delete('/api/devices/:id', async (req, res, { params }) => {
    const { user } = requireUser(req);
    auth.revokeDevice(db, user.id, Number(params.id), 'remote_logout');
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me', async (req, res) => {
    const { user } = requireUser(req);
    sendJson(res, 200, {
      user: auth.publicUser(user),
      balanceTokens: ledgerBalance(db, user.id),
      spendableTokens: spendableTokens(db, user.id),
      isAdminPhone: isAdminPhone(cfg, user.phone), // informational only — admin access lives in the separate admin app
    });
  });

  router.get('/api/packs', async (req, res) => {
    requireUser(req);
    sendJson(res, 200, { packs: getPacks(db, cfg), card: getCard(db, cfg) });
  });

  router.get('/api/models', async (req, res) => {
    requireUser(req);
    sendJson(res, 200, { models: getModels(db, cfg) });
  });

  router.post('/api/orders', async (req, res) => {
    const { user } = requireUser(req);
    const body = await readJson(req);
    const order = createOrder(db, cfg, user, body);
    sendJson(res, 201, { order: publicOrder(order) });
  });

  router.get('/api/orders', async (req, res) => {
    const { user } = requireUser(req);
    sendJson(res, 200, { orders: userOrders(db, user.id).map(publicOrder) });
  });

  router.get('/api/credits', async (req, res) => {
    const { user } = requireUser(req);
    sendJson(res, 200, {
      balanceTokens: ledgerBalance(db, user.id),
      spendableTokens: spendableTokens(db, user.id),
      ledger: userLedger(db, user.id),
      orders: userOrders(db, user.id).map(publicOrder),
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    const { user } = requireUser(req);
    if (!user.is_active) throw forbidden('account_disabled', 'Account disabled.');
    await handleChatCompletions(db, cfg, req, res, user);
  });

  router.get('/healthz', async (req, res) => sendJson(res, 200, { ok: true, service: 'ronin-api' }));

  const handler = withErrorHandling((req, res) => router.handle(req, res, {}));
  return http.createServer((req, res) => { void handler(req, res, {}); });
}
