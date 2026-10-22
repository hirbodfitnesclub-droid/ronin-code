import http from 'node:http';
import crypto from 'node:crypto';
import { createRouter, withErrorHandling, sendJson, readJson, readBody, bearer, clientIp } from './http.js';
import { normalizePhone, badRequest, forbidden, unauthorized, HttpError, timingSafeEqualStr } from './util.js';
import { isAdminPhone } from './util.js';
import * as auth from './auth.js';
import { CATALOG } from './catalog.js';
import { getPacks, getCard, getModels } from './settings.js';
import { ledgerBalance, spendableTokens, userLedger } from './ledger.js';
import { createOrder, userOrders, publicOrder } from './orders.js';
import { handleChatCompletions } from './proxy.js';
import { requireRateLimit } from './ratelimit.js';
import { createStorage } from './storage.js';
import { parseMultipart } from './upload.js';

/** User API application (no admin surface here at all — the admin is a separate app). */
export function createUserApp(db, cfg, sms) {
  const storage = createStorage(cfg);
  const router = createRouter();
  const requireUser = (req) => auth.authenticate(db, cfg, bearer(req));

  // ── Supabase Auth Send SMS Hook ─────────────────────────────────────────
  // GoTrue generates the OTP, then calls this endpoint (Standard-Webhooks
  // signed) to deliver it. Kavenegar is not a built-in Supabase SMS
  // provider, so delivery happens here, through our SMS service.
  router.post('/hooks/send-sms', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    if (!verifyHookSignature(cfg, raw, req.headers)) {
      throw unauthorized('invalid_signature', 'Invalid webhook signature.');
    }
    let payload;
    try { payload = JSON.parse(raw || '{}'); }
    catch { throw badRequest('invalid_json', 'Hook body must be JSON.'); }
    const phoneRaw = payload?.user?.phone;
    const otp = payload?.sms?.otp;
    if (!phoneRaw || !otp) throw badRequest('invalid_hook_payload', 'Hook payload needs user.phone and sms.otp.');
    const phone = normalizePhone(auth.toLocalPhone(phoneRaw));
    if (!phone) throw badRequest('invalid_hook_phone', 'Hook payload phone is not a valid Iranian mobile.');
    const out = await sms.sendOtp(phone, String(otp));
    if (out?.error) throw new HttpError(500, 'sms_delivery_failed', 'SMS delivery failed.');
    sendJson(res, 200, {});
  });

  router.post('/api/auth/otp/request', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid Iranian mobile number (09xxxxxxxxx).');
    await auth.requestOtp(db, cfg, { phone, ip: clientIp(req) });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/auth/otp/verify', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone || !body.code) throw badRequest('invalid_input', 'phone and code are required.');
    const out = await auth.loginWithOtp(db, cfg, {
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

  // ── Handoff return codes (web panel → desktop app) ──────────────────────
  // A signed-in user mints a one-time code in the panel; the desktop app
  // exchanges it for a full app session (see auth.js for why these are our
  // own sessions, not GoTrue's).
  router.post('/api/auth/handoff', async (req, res) => {
    const { user } = await requireUser(req);
    const out = await auth.issueHandoffCode(db, user.id);
    sendJson(res, 200, { code: out.code, expiresInSec: out.expiresInSec });
  });

  router.post('/api/auth/handoff/exchange', async (req, res) => {
    // Public endpoint — brute-force surface, so it is rate-limited per IP
    // (20/hour) before any code lookup happens.
    await requireRateLimit(db, `handoff:ex:${clientIp(req)}`, 20, 60 * 60 * 1000, 'handoff_rate_limited');
    const body = await readJson(req);
    if (!body.code) throw badRequest('invalid_code', 'code is required.');
    const out = await auth.exchangeHandoffCode(db, cfg, {
      code: String(body.code),
      deviceName: body.deviceName ? String(body.deviceName).slice(0, 80) : null,
    });
    sendJson(res, 200, {
      accessToken: out.accessToken, refreshToken: out.refreshToken,
      accessExpiresInSec: Math.floor(auth.ACCESS_TTL_MS / 1000),
      user: out.user, deviceId: out.deviceId,
    });
  });

  router.post('/api/auth/refresh', async (req, res) => {
    const body = await readJson(req);
    const out = await auth.refreshSession(db, cfg, body.refreshToken);
    sendJson(res, 200, {
      accessToken: out.accessToken, refreshToken: out.refreshToken,
      user: out.user, deviceId: out.deviceId,
    });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const { sessionId } = await requireUser(req);
    await auth.revokeSession(db, sessionId);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/auth/logout-all', async (req, res) => {
    const { user } = await requireUser(req);
    await auth.logoutAll(db, user.id);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/devices', async (req, res) => {
    const { user } = await requireUser(req);
    sendJson(res, 200, { devices: await auth.listDevices(db, user.id) });
  });

  router.delete('/api/devices/:id', async (req, res, { params }) => {
    const { user } = await requireUser(req);
    await auth.revokeDevice(db, user.id, params.id, 'remote_logout');
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me', async (req, res) => {
    const { user } = await requireUser(req);
    sendJson(res, 200, {
      user: auth.publicUser(user),
      balanceTokens: await ledgerBalance(db, user.id),
      spendableTokens: await spendableTokens(db, user.id),
      isAdminPhone: isAdminPhone(cfg, user.phone), // informational only — admin access lives in the separate admin app
    });
  });

  // First-login onboarding (one short screen): name + acquisition source
  // (required) and an optional goal. One atomic UPDATE flips `onboarded`;
  // resubmitting is a harmless overwrite.
  const ACQUISITION_SOURCES = ['instagram', 'telegram', 'friend', 'google', 'youtube_aparat', 'other'];
  const ONBOARDING_GOALS = ['personal', 'freelance', 'business', 'learning', 'other'];
  router.post('/api/me/onboarding', async (req, res) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (name.length < 2) throw badRequest('name_required', 'Your name is required.');
    const source = String(body.acquisitionSource ?? '');
    if (!ACQUISITION_SOURCES.includes(source)) throw badRequest('invalid_source', 'Choose how you heard about us.');
    let goal = null;
    if (body.onboardingGoal !== undefined && body.onboardingGoal !== null && body.onboardingGoal !== '') {
      goal = String(body.onboardingGoal);
      if (!ONBOARDING_GOALS.includes(goal)) throw badRequest('invalid_goal', 'Unknown onboarding goal.');
    }
    const row = await db.one(
      `UPDATE public.users SET name = $2, acquisition_source = $3, onboarding_goal = $4, onboarded = true
       WHERE id = $1 RETURNING *`,
      [user.id, name, source, goal]);
    sendJson(res, 200, { user: auth.publicUser(row) });
  });

  // Daily revalidation: the desktop app calls this on every launch and at
  // least once a day. All truth is server-side (server clock, server
  // ledger); the device registry decides deviceAuthorized.
  router.get('/api/account-status', async (req, res, { query }) => {
    const { user, deviceId } = await requireUser(req);
    const status = await auth.accountStatus(db, user.id, query.get('deviceId') || deviceId);
    sendJson(res, 200, { userId: user.id, ...status });
  });

  router.get('/api/packs', async (req, res) => {
    await requireUser(req);
    // RATE AUDIT: the pack's `usd` value (and anything it implies about the
    // exchange rate) is server-only — the user API exposes final prices only.
    const packs = (await getPacks(db, cfg)).map((p) => ({
      id: p.id, title: p.title, tokens: p.tokens, priceRials: p.priceRials,
      validityDays: p.validityDays ?? null, badge: p.badge ?? null,
    }));
    sendJson(res, 200, { packs, card: await getCard(db, cfg) });
  });

  router.get('/api/models', async (req, res) => {
    await requireUser(req);
    // Merge the settings-table entries (multiplier/enabled — admin-editable)
    // with the static catalog metadata (display name, family, context…).
    const byId = new Map(CATALOG.map((m) => [m.id, m]));
    const models = (await getModels(db, cfg)).map((e) => {
      const meta = byId.get(e.model);
      return {
        id: e.model,
        name: meta?.name ?? e.model,
        family: meta?.family ?? 'Other',
        coeff: Number(e.multiplier),
        fastCoeff: e.fastMultiplier ?? null,
        context: meta?.context ?? null,
        inputs: meta?.inputs ?? [],
        efforts: meta?.efforts ?? [],
        enabled: e.enabled !== false,
      };
    });
    sendJson(res, 200, { models });
  });

  // Card-to-card claim = ONE receipt image (multipart/form-data):
  // fields: packId · file part: receipt (image/*, ≤ receiptMaxBytes).
  // No other claim fields exist (owner decision — receipt photo only).
  router.post('/api/orders', async (req, res) => {
    const { user } = await requireUser(req);
    const raw = await readBody(req, cfg.receiptMaxBytes + 256 * 1024);
    const { fields, files } = parseMultipart(raw, req.headers['content-type']);
    const order = await createOrder(db, cfg, storage, user, {
      packId: fields.packId,
      receipt: files.receipt ? { data: files.receipt.data, contentType: files.receipt.contentType } : null,
    });
    sendJson(res, 201, { order: publicOrder(order) });
  });

  router.get('/api/orders', async (req, res) => {
    const { user } = await requireUser(req);
    sendJson(res, 200, { orders: (await userOrders(db, user.id)).map(publicOrder) });
  });

  router.get('/api/credits', async (req, res) => {
    const { user } = await requireUser(req);
    sendJson(res, 200, {
      balanceTokens: await ledgerBalance(db, user.id),
      spendableTokens: await spendableTokens(db, user.id),
      ledger: await userLedger(db, user.id),
      orders: (await userOrders(db, user.id)).map(publicOrder),
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    const { user } = await requireUser(req);
    if (!user.is_active) throw forbidden('account_disabled', 'Account disabled.');
    await handleChatCompletions(db, cfg, req, res, user);
  });

  router.get('/healthz', async (req, res) => sendJson(res, 200, { ok: true, service: 'ronin-api' }));

  const handler = withErrorHandling((req, res) => router.handle(req, res, {}));
  return http.createServer((req, res) => { void handler(req, res, {}); });
}

/**
 * Standard Webhooks signature check for the Send SMS Hook.
 * Configured secret format (same string given to GoTrue): `v1,whsec_<base64>`.
 * When no secret is configured the endpoint is unauthenticated — local dev
 * only; startup logs a warning in that case.
 */
export function verifyHookSignature(cfg, rawBody, headers) {
  const secret = cfg.authHookSecret;
  if (!secret) return true;
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || !sigHeader) return false;
  let b64 = secret.startsWith('v1,') ? secret.slice(3) : secret;
  if (b64.startsWith('whsec_')) b64 = b64.slice(6);
  let key;
  try { key = Buffer.from(b64, 'base64'); } catch { return false; }
  const expected = `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64')}`;
  return String(sigHeader).split(' ').some((s) => timingSafeEqualStr(s, expected));
}
