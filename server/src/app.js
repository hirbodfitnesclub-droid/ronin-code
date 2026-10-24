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
import { effectivePerUser, routingModeFor, getKeyRow, routedPerUser } from './reseller/routing.js';
import { getProviderBalance } from './reseller/balance.js';
import { decryptDelegatedKey, fingerprintOf } from './reseller/crypto.js';
import { createResellerClient } from './reseller/client.js';
import { ensureConversionIntent } from './reseller/conversion.js';
import { ms as msUtil } from './util.js';
import { createStorage } from './storage.js';
import { parseMultipart } from './upload.js';

/** User API application (no admin surface here at all — the admin is a separate app). */
export function createUserHandler(db, cfg, sms) {
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

  /** Per-user balance substitution (§7.1): provider balance replaces the
   *  ledger figure on display surfaces when the user routes per-user. */
  async function perUserBalance(userId) {
    const { perUser, keyRow } = await routedPerUser(db, cfg, userId);
    if (!perUser || !keyRow) return null;
    const bal = await getProviderBalance(db, cfg, keyRow);
    return { ...bal, keyRow };
  }

  router.get('/api/me', async (req, res) => {
    const { user } = await requireUser(req);
    const pu = await perUserBalance(user.id);
    sendJson(res, 200, {
      user: auth.publicUser(user),
      balanceTokens: pu && !pu.unavailable ? pu.balance : await ledgerBalance(db, user.id),
      spendableTokens: pu && !pu.unavailable ? pu.balance : await spendableTokens(db, user.id),
      routingMode: await routingModeFor(db, cfg, user.id),
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
    // Lazy conversion trigger (§9.1a): first account-status after the flag
    // reaches this user freezes their v1 balance into a convert intent.
    let keyRow = await getKeyRow(db, user.id);
    if (await effectivePerUser(db, cfg, user.id)) {
      if (!keyRow?.converted_at) {
        await ensureConversionIntent(db, cfg, user.id).catch(() => {});
        keyRow = await getKeyRow(db, user.id);
      }
    }
    const routingMode = await routingModeFor(db, cfg, user.id);
    const out = { userId: user.id, ...status, routingMode };
    if (keyRow) {
      const liveIntent = await db.one(
        "SELECT id FROM public.key_issuance_intents WHERE user_id = $1 AND kind = 'convert' AND state IN ('pending','in_flight','issued') ORDER BY id DESC LIMIT 1",
        [user.id]);
      out.providerKey = {
        status: liveIntent && keyRow.converted_at && !keyRow.encrypted_key ? 'converting' : keyRow.status,
        tokenLimitIssued: Number(keyRow.token_limit_issued ?? 0),
        balanceStale: false,
      };
      const { perUser } = await routedPerUser(db, cfg, user.id);
      if (perUser) {
        const bal = await getProviderBalance(db, cfg, keyRow);
        if (!bal.unavailable) {
          out.balanceTokens = bal.balance;
          out.spendableTokens = bal.balance;
          out.lots = [];
          out.providerKey.balanceStale = bal.stale;
        }
      }
    }
    sendJson(res, 200, out);
  });

  // ── Phase 2: delegated-key delivery (§5.2) ─────────────────────────────
  router.get('/api/subscription/credential', async (req, res) => {
    const { user } = await requireUser(req); // authenticate() enforces device registry + is_active
    await requireRateLimit(db, `credential:${user.id}`, 30, 3_600_000, 'credential_rate_limited');
    res.setHeader('Cache-Control', 'no-store');
    if (!(await effectivePerUser(db, cfg, user.id))) {
      return sendJson(res, 200, { routingMode: 'shared' });
    }
    const keyRow = await getKeyRow(db, user.id);
    if (!keyRow) return sendJson(res, 200, { routingMode: 'per_user', keyStatus: 'none' });
    const base = {
      routingMode: 'per_user', keyStatus: keyRow.status,
      tokenLimitIssued: Number(keyRow.token_limit_issued ?? 0),
      issuedAt: msUtil(keyRow.updated_at),
    };
    if (keyRow.status === 'frozen') return sendJson(res, 200, base); // no plaintext for frozen keys
    if (keyRow.status === 'active' && keyRow.encrypted_key) {
      let plain;
      try {
        plain = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: user.id, keyRowId: keyRow.id });
      } catch {
        return sendJson(res, 200, { ...base, keyStatus: 'needs_attention' });
      }
      return sendJson(res, 200, {
        ...base, delegatedKey: plain, keyFingerprint: fingerprintOf(plain), keyLast4: keyRow.key_last4,
        providerBaseUrl: cfg.cvcBaseUrl,
      });
    }
    return sendJson(res, 200, base);
  });

  // ── Phase 2: provider usage for panels (§7.2/§7.3) ─────────────────────
  router.get('/api/usage/recent', async (req, res) => {
    const { user } = await requireUser(req);
    const keyRow = await getKeyRow(db, user.id);
    if (!keyRow?.encrypted_key || !(await effectivePerUser(db, cfg, user.id))) {
      return sendJson(res, 200, { rows: [], totalRequests: 0, windowNote: 'recent_30' });
    }
    let plain;
    try { plain = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: user.id, keyRowId: keyRow.id }); }
    catch { return sendJson(res, 200, { rows: [], totalRequests: 0, windowNote: 'recent_30' }); }
    const client = createResellerClient(cfg);
    const { logs, total } = await client.getLogs(plain);
    sendJson(res, 200, {
      rows: logs.map((l) => ({
        model: l.model, reasoningEffort: l.reasoning_effort ?? null,
        inputTokens: Number(l.input_tokens ?? 0), outputTokens: Number(l.output_tokens ?? 0),
        cachedTokens: Number(l.cached_tokens ?? 0), costTokens: Number(l.cost_tokens ?? 0),
        fast: Boolean(l.fast), status: l.status, createdAt: l.created_at,
      })),
      totalRequests: total, windowNote: 'recent_30',
    });
  });

  router.get('/api/usage/summary', async (req, res) => {
    const { user } = await requireUser(req);
    // UsageSummary shape (user panel types): today/month in Asia/Tehran days,
    // built from key_usage_daily rollups (§7.3). Partial days are a lower bound.
    const todayRow = await db.one(
      `SELECT COALESCE(SUM(cost_tokens),0)::bigint AS s FROM public.key_usage_daily
       WHERE user_id = $1 AND day = (now() AT TIME ZONE 'Asia/Tehran')::date`, [user.id]);
    const monthRow = await db.one(
      `SELECT COALESCE(SUM(cost_tokens),0)::bigint AS s FROM public.key_usage_daily
       WHERE user_id = $1 AND day >= (date_trunc('month', (now() AT TIME ZONE 'Asia/Tehran')))::date`, [user.id]);
    const days = await db.many(
      `SELECT day, COALESCE(SUM(cost_tokens),0)::bigint AS tokens, bool_or(partial) AS partial
       FROM public.key_usage_daily
       WHERE user_id = $1 AND day > (now() AT TIME ZONE 'Asia/Tehran')::date - 7
       GROUP BY day ORDER BY day`, [user.id]);
    const models = await db.many(
      `SELECT model, COALESCE(SUM(cost_tokens),0)::bigint AS tokens FROM public.key_usage_daily
       WHERE user_id = $1 GROUP BY model ORDER BY tokens DESC LIMIT 5`, [user.id]);
    const byDay = new Map(days.map((d) => [String(d.day instanceof Date ? d.day.toISOString().slice(0, 10) : d.day).slice(0, 10), d]));
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86_400_000);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(dt);
      const hit = byDay.get(key);
      last7Days.push({ date: key, tokens: hit ? Number(hit.tokens) : 0, ...(hit?.partial ? { partial: true } : {}) });
    }
    sendJson(res, 200, {
      todayTokens: Number(todayRow.s), monthTokens: Number(monthRow.s),
      last7Days,
      topModels: models.map((m) => ({ model: m.model, tokens: Number(m.tokens) })),
      hasPartialDays: days.some((d) => d.partial),
    });
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
    const orders = await userOrders(db, user.id);
    const out = [];
    for (const o of orders) {
      const intent = await db.one(
        `SELECT state FROM public.key_issuance_intents WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [o.id]);
      out.push(publicOrder(o, intent ? { issuanceState: intent.state } : {}));
    }
    sendJson(res, 200, { orders: out });
  });

  router.get('/api/credits', async (req, res) => {
    const { user } = await requireUser(req);
    const pu = await perUserBalance(user.id);
    sendJson(res, 200, {
      balanceTokens: pu && !pu.unavailable ? pu.balance : await ledgerBalance(db, user.id),
      spendableTokens: pu && !pu.unavailable ? pu.balance : await spendableTokens(db, user.id),
      routingMode: await routingModeFor(db, cfg, user.id),
      ledger: await userLedger(db, user.id),
      orders: (await userOrders(db, user.id)).map(publicOrder),
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    // Dual-auth (§6.2): (B) a delegated-key Bearer authenticates by
    // fingerprint lookup — no session/device requirement; (A) otherwise the
    // session Bearer goes through the normal authenticate() path.
    const token = bearer(req);
    if (token) {
      const fp = fingerprintOf(token);
      const keyRow = await db.one('SELECT * FROM public.user_provider_keys WHERE key_fingerprint = $1', [fp]);
      if (keyRow) {
        const user = await db.one('SELECT * FROM public.users WHERE id = $1', [keyRow.user_id]);
        if (user) {
          return handleChatCompletions(db, cfg, req, res, user, { delegatedKey: token, keyRow });
        }
      }
    }
    const { user } = await requireUser(req);
    if (!user.is_active) throw forbidden('account_disabled', 'Account disabled.');
    await handleChatCompletions(db, cfg, req, res, user);
  });

  router.get('/healthz', async (req, res) => sendJson(res, 200, { ok: true, service: 'ronin-api' }));

  const handler = withErrorHandling((req, res) => router.handle(req, res, {}));
  return (req, res) => { void handler(req, res, {}); };
}

export function createUserApp(db, cfg, sms) {
  return http.createServer(createUserHandler(db, cfg, sms));
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
