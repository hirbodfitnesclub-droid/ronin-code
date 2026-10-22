import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, withErrorHandling, sendJson, sendHtml, readJson, clientIp } from '../http.js';
import { normalizePhone, badRequest, notFound, conflict, ms, num } from '../util.js';
import { audit } from '../db.js';
import { getSetting, setSetting, getPacks } from '../settings.js';
import { ledgerBalance, adjustCredit, userLedger } from '../ledger.js';
import * as auth from '../auth.js';
import { listOrders, getOrder, reviewOrder, publicOrder } from '../orders.js';
import * as adminAuth from './auth.js';
import { effectiveCaps, requireCap, requireOwner, getFinanceStaff, sanitizeCaps } from './caps.js';
import { registerFinanceRoutes } from './finance.js';
import { registerAnalyticsRoutes } from './analytics.js';

const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(ADMIN_DIR, '../../../web/admin-panel/dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * The STANDALONE admin application: its own HTTP server (ADMIN_PORT), its own
 * login, its own session domain (admin_sessions + ronin_admin cookie +
 * per-session CSRF token). Nothing here is reachable through the user API.
 *
 * Access model (PRD §6.1, Liro capability staff): OWNER = phone in
 * ADMIN_PHONES (all capabilities, claim approval, staff editing, audit);
 * FINANCE STAFF = settings `finance_staff` [{phone, caps[]}] — login allowed,
 * every route enforces its capability server-side (see caps.js). Every
 * sensitive action writes an admin_audit row.
 *
 * The React console (web/admin-panel) is served from its Vite build output;
 * money mutations go through the SECURITY DEFINER RPCs only.
 */
export function createAdminApp(db, cfg, sms) {
  const router = createRouter();
  const guard = async (req, { mutate = false } = {}) => {
    const session = await adminAuth.authenticateAdmin(db, req);
    if (mutate) adminAuth.requireCsrf(session, req);
    return session;
  };
  const guardCap = (cap, opts) => async (req) => {
    const session = await guard(req, opts);
    await requireCap(db, cfg, session, cap);
    return session;
  };
  const guardOwner = (opts) => async (req) => {
    const session = await guard(req, opts);
    await requireOwner(cfg, session);
    return session;
  };

  // ── auth ────────────────────────────────────────────────────────────────
  router.post('/admin-api/auth/otp/request', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid Iranian mobile number.');
    await adminAuth.requestAdminOtp(db, cfg, sms, { phone, ip: clientIp(req) });
    sendJson(res, 200, { ok: true });
  });

  router.post('/admin-api/auth/otp/verify', async (req, res) => {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone ?? '');
    if (!phone || !body.code) throw badRequest('invalid_input', 'phone and code are required.');
    const out = await adminAuth.loginAdminWithOtp(db, cfg, { phone, code: String(body.code) });
    const eff = await effectiveCaps(db, cfg, phone);
    await audit(db, phone, 'admin_login', 'admin', { role: eff?.role ?? 'unknown' });
    res.setHeader('Set-Cookie', adminAuth.adminCookieHeader(out.token, cfg.cookieSecure));
    sendJson(res, 200, { phone: out.phone, csrfToken: out.csrfToken, role: eff?.role, caps: eff?.caps ?? [] });
  });

  router.post('/admin-api/auth/logout', async (req, res) => {
    const session = await guard(req, { mutate: true });
    const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${adminAuth.ADMIN_COOKIE}=`));
    await adminAuth.logoutAdmin(db, cookie ? decodeURIComponent(cookie.slice(adminAuth.ADMIN_COOKIE.length + 1)) : null);
    await audit(db, session.phone, 'admin_logout', 'admin', null);
    res.setHeader('Set-Cookie', adminAuth.clearAdminCookieHeader());
    sendJson(res, 200, { ok: true });
  });

  router.get('/admin-api/session', async (req, res) => {
    const session = await guard(req);
    const eff = await effectiveCaps(db, cfg, session.phone);
    if (!eff) throw notFound('not_an_admin', 'This session is no longer an admin.');
    sendJson(res, 200, { phone: session.phone, csrfToken: session.csrf_token, role: eff.role, caps: eff.caps });
  });

  // ── dashboard ───────────────────────────────────────────────────────────
  router.get('/admin-api/overview', async (req, res) => {
    await guardCap('finance_view')(req);
    const users = (await db.one('SELECT count(*)::int AS c FROM public.users')).c;
    const revenue = Number((await db.one("SELECT COALESCE(SUM(received_amount_rials),0)::bigint AS s FROM public.orders WHERE status IN ('approved','refunded')")).s);
    const pending = (await db.one("SELECT count(*)::int AS c FROM public.orders WHERE status = 'pending'")).c;
    const consumed = Number((await db.one("SELECT COALESCE(-SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind = 'consume'")).s);
    const granted = Number((await db.one("SELECT COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind IN ('purchase','adjust') AND delta_tokens > 0")).s);
    const refunds = Number((await db.one('SELECT COALESCE(SUM(amount_rials),0)::bigint AS s FROM public.order_refunds')).s);
    sendJson(res, 200, { users, revenueRials: revenue, pendingOrders: pending, tokensConsumed: consumed, tokensGranted: granted, refundedRials: refunds });
  });

  // ── users ───────────────────────────────────────────────────────────────
  router.get('/admin-api/users', async (req, res, { query }) => {
    await guardCap('finance_user')(req);
    const search = (query.get('search') || '').trim();
    const rows = search
      ? await db.many('SELECT * FROM public.users WHERE phone ILIKE $1 OR name ILIKE $1 ORDER BY created_at DESC LIMIT 100', [`%${search}%`])
      : await db.many('SELECT * FROM public.users ORDER BY created_at DESC LIMIT 100');
    const users = [];
    for (const u of rows) {
      users.push({
        id: u.id, phone: u.phone, name: u.name, isActive: Boolean(u.is_active),
        balanceTokens: await ledgerBalance(db, u.id), createdAt: ms(u.created_at), lastLoginAt: ms(u.last_login_at),
      });
    }
    sendJson(res, 200, { users });
  });

  router.get('/admin-api/users/:id', async (req, res, { params }) => {
    await guardCap('finance_user')(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const lotRows = await db.many('SELECT id, source, tokens_total, tokens_left, expires_at, created_at FROM public.credit_lots WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [user.id]);
    const openFlags = (await db.one("SELECT count(*)::int AS c FROM public.risk_flags WHERE user_id = $1 AND status = 'open'", [user.id])).c;
    sendJson(res, 200, {
      user: { id: user.id, phone: user.phone, name: user.name, isActive: Boolean(user.is_active), createdAt: ms(user.created_at), lastLoginAt: ms(user.last_login_at) },
      balanceTokens: await ledgerBalance(db, user.id),
      ledger: await userLedger(db, user.id, 100),
      orders: (await db.many('SELECT * FROM public.orders WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [user.id])).map(publicOrder),
      lots: lotRows.map((l) => ({
        id: Number(l.id), source: l.source,
        tokensTotal: Number(l.tokens_total), tokensLeft: Number(l.tokens_left),
        expiresAt: ms(l.expires_at), createdAt: ms(l.created_at),
      })),
      openRiskFlags: openFlags,
    });
  });

  router.post('/admin-api/users/:id/toggle-active', async (req, res, { params }) => {
    const session = await guardCap('risk_manage', { mutate: true })(req);
    const body = await readJson(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const active = body.isActive === undefined ? !user.is_active : Boolean(body.isActive);
    await db.query('UPDATE public.users SET is_active = $2 WHERE id = $1', [user.id, active]);
    if (!active) await auth.logoutAll(db, user.id); // disabling also kills live sessions/devices
    await audit(db, session.phone, active ? 'user_activated' : 'user_deactivated', `user:${user.id}`, null);
    sendJson(res, 200, { ok: true, isActive: active });
  });

  router.post('/admin-api/users/:id/charge', async (req, res, { params }) => {
    const session = await guardCap('finance_user', { mutate: true })(req);
    const body = await readJson(req);
    const tokens = Number(body.tokens);
    // Four-eyes culture (Liro): a manual balance change is impossible without a written note.
    if (!body.note || String(body.note).trim().length < 3) throw badRequest('note_required', 'A note (reason) is required for manual charges.');
    if (!Number.isInteger(tokens) || tokens === 0) throw badRequest('invalid_tokens', 'tokens must be a non-zero integer (negative = debit).');
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const balanceAfter = await adjustCredit(db, {
      userId: user.id, tokens, actor: `admin:${session.phone}`, note: String(body.note),
    });
    await audit(db, session.phone, 'user_manual_charge', `user:${user.id}`, { tokens, note: String(body.note) });
    sendJson(res, 200, { ok: true, balanceTokens: balanceAfter });
  });

  // ── user devices + risk flags ────────────────────────────────────────────
  router.get('/admin-api/users/:id/devices', async (req, res, { params }) => {
    await guardCap('finance_user')(req);
    const user = await db.one('SELECT id FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    sendJson(res, 200, { devices: await auth.listDevices(db, user.id) });
  });

  router.post('/admin-api/users/:id/devices/:deviceId/revoke', async (req, res, { params }) => {
    const session = await guardCap('risk_manage', { mutate: true })(req);
    const user = await db.one('SELECT id FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    await auth.revokeDevice(db, user.id, params.deviceId);
    await audit(db, session.phone, 'device_revoked', `user:${user.id}`, { deviceId: params.deviceId });
    sendJson(res, 200, { ok: true, devices: await auth.listDevices(db, user.id) });
  });

  const publicFlag = (f) => ({
    id: Number(f.id), userId: f.user_id, kind: f.kind, note: f.note, status: f.status,
    createdBy: f.created_by, createdAt: ms(f.created_at),
    resolvedBy: f.resolved_by, resolvedAt: ms(f.resolved_at),
  });

  router.get('/admin-api/users/:id/risk-flags', async (req, res, { params }) => {
    await guardCap('risk_manage')(req);
    const rows = await db.many('SELECT * FROM public.risk_flags WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [params.id]);
    sendJson(res, 200, { flags: rows.map(publicFlag) });
  });

  router.post('/admin-api/users/:id/risk-flags', async (req, res, { params }) => {
    const session = await guardCap('risk_manage', { mutate: true })(req);
    const body = await readJson(req);
    const user = await db.one('SELECT id FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const kind = String(body.kind ?? '').trim();
    if (!kind || kind.length > 40) throw badRequest('invalid_kind', 'kind is required (max 40 chars).');
    const row = await db.one(
      'INSERT INTO public.risk_flags (user_id, kind, note, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [user.id, kind, body.note ? String(body.note).slice(0, 500) : null, session.phone]);
    await audit(db, session.phone, 'risk_flag_created', `user:${user.id}`, { kind, flagId: Number(row.id) });
    sendJson(res, 201, { flag: publicFlag(row) });
  });

  router.post('/admin-api/risk-flags/:id/resolve', async (req, res, { params }) => {
    const session = await guardCap('risk_manage', { mutate: true })(req);
    const row = await db.one(
      "UPDATE public.risk_flags SET status = 'resolved', resolved_by = $2, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *",
      [Number(params.id), session.phone]);
    if (!row) throw notFound('flag_not_found', 'Risk flag not found or already resolved.');
    await audit(db, session.phone, 'risk_flag_resolved', `user:${row.user_id}`, { flagId: Number(row.id) });
    sendJson(res, 200, { flag: publicFlag(row) });
  });

  // ── orders queue + receipts + refunds ────────────────────────────────────
  /** Passive duplicate-receipt flag: same image hash on OTHER claims. */
  async function duplicateFlags(orders) {
    const hashes = [...new Set(orders.map((o) => o.receipt_sha256).filter(Boolean))];
    if (!hashes.length) return new Map();
    const rows = await db.many(
      'SELECT receipt_sha256, count(*)::int AS c FROM public.orders WHERE receipt_sha256 = ANY($1) GROUP BY receipt_sha256',
      [hashes]);
    return new Map(rows.map((r) => [r.receipt_sha256, r.c]));
  }
  const publicOrderAdmin = (o, dupCounts) => ({
    ...publicOrder(o),
    hasReceipt: Boolean(o.receipt_path),
    duplicateReceipt: Boolean(o.receipt_sha256 && dupCounts?.get(o.receipt_sha256) > 1),
  });

  router.get('/admin-api/orders', async (req, res, { query }) => {
    await guardCap('finance_view')(req);
    const status = query.get('status');
    const rows = await listOrders(db, { status: status || null, limit: 200 });
    const dupCounts = await duplicateFlags(rows);
    sendJson(res, 200, { orders: rows.map((o) => publicOrderAdmin(o, dupCounts)) });
  });

  router.get('/admin-api/orders/:id', async (req, res, { params }) => {
    await guardCap('finance_view')(req);
    const order = await getOrder(db, Number(params.id));
    if (!order) throw notFound('order_not_found', 'Order not found.');
    const user = await db.one('SELECT id, phone, name FROM public.users WHERE id = $1', [order.user_id]);
    const dupCounts = await duplicateFlags([order]);
    const refundRows = await db.many('SELECT * FROM public.order_refunds WHERE order_id = $1 ORDER BY id DESC', [order.id]);
    sendJson(res, 200, {
      order: publicOrderAdmin({ ...order, user_phone: user?.phone }, dupCounts),
      user,
      refunds: refundRows.map((r) => ({
        id: Number(r.id), orderId: Number(r.order_id), amountRials: Number(r.amount_rials),
        tokensRemoved: Number(r.tokens_removed), reason: r.reason, reference: r.reference,
        actor: r.actor, createdAt: ms(r.created_at),
      })),
    });
  });

  router.get('/admin-api/orders/:id/receipt', async (req, res, { params }) => {
    const session = await guardCap('finance_view')(req);
    const order = await getOrder(db, Number(params.id));
    if (!order) throw notFound('order_not_found', 'Order not found.');
    if (!order.receipt_path) throw notFound('receipt_not_found', 'This claim has no receipt image.');
    await audit(db, session.phone, 'receipt_viewed', `order:${order.id}`, null);

    // Local development store: plain files under RECEIPTS_DIR.
    if (cfg.receiptsDir) {
      const root = path.resolve(cfg.receiptsDir);
      const file = path.resolve(root, '.' + path.sep + order.receipt_path);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': IMG_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'private, no-store',
        });
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(file);
          stream.on('error', reject);
          res.on('finish', resolve);
          stream.pipe(res);
        });
        return;
      }
    }
    // Supabase Cloud: short-lived signed URL into the private bucket.
    if (cfg.supabaseUrl && cfg.supabaseServiceRoleKey) {
      const sign = await fetch(
        `${cfg.supabaseUrl}/storage/v1/object/sign/${cfg.receiptsBucket}/${order.receipt_path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: cfg.supabaseServiceRoleKey,
            Authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
          },
          body: JSON.stringify({ expiresIn: 600 }),
        });
      const data = await sign.json().catch(() => null);
      if (sign.ok && data?.signedURL) {
        res.writeHead(302, { Location: `${cfg.supabaseUrl}${data.signedURL}`, 'Cache-Control': 'private, no-store' });
        return res.end();
      }
    }
    throw notFound('receipt_unavailable', 'Receipt storage is not reachable from this server.');
  });

  router.post('/admin-api/orders/:id/review', async (req, res, { params }) => {
    // Liro semantics: claim APPROVAL is the owner's call (requireAdmin).
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    const before = await getOrder(db, Number(params.id));
    if (!before) throw notFound('order_not_found', 'Order not found.');
    const { order, grantedTokens } = await reviewOrder(db, cfg, session.phone, before.id, {
      action: body.action,
      receivedAmountRials: body.receivedAmountRials,
      reason: body.reason, note: body.note,
    });
    // Liro-style SMS follow-up (fire-and-forget; templates from env).
    const user = await db.one('SELECT phone FROM public.users WHERE id = $1', [order.user_id]);
    if (user) {
      if (order.status === 'approved') void sms.sendPackageActivated(user.phone, grantedTokens, order.pack_title);
      else if (order.status === 'rejected') void sms.sendOrderRejected(user.phone, order.reject_reason);
    }
    const dupCounts = await duplicateFlags([order]);
    sendJson(res, 200, { order: publicOrderAdmin(order, dupCounts), grantedTokens });
  });

  router.post('/admin-api/orders/:id/refund', async (req, res, { params }) => {
    const session = await guardCap('refund_write', { mutate: true })(req);
    const body = await readJson(req);
    const amountRials = Number(body.amountRials);
    if (!Number.isInteger(amountRials) || amountRials <= 0) throw badRequest('invalid_amount', 'amountRials must be a positive integer.');
    if (!body.reason || String(body.reason).trim().length < 3) throw badRequest('reason_required', 'A refund reason is required.');
    if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string') throw badRequest('idempotency_key_required', 'idempotencyKey is required.');
    const row = await db.one('SELECT public.refund_order($1,$2,$3,$4,$5,$6) AS r',
      [Number(params.id), session.phone, amountRials, String(body.reason).slice(0, 500),
       body.reference ? String(body.reference).slice(0, 100) : null, body.idempotencyKey]);
    const r = row.r;
    if (!r.ok) {
      if (r.error === 'order_not_found') throw notFound('order_not_found', 'Order not found.');
      if (r.error === 'not_approved') throw conflict('not_approved', `Order is ${r.status}; only approved orders can be refunded.`);
      if (r.error === 'exceeds_received') throw badRequest('exceeds_received', 'Refund exceeds the amount received for this order.');
      throw badRequest(r.error || 'refund_failed', 'Refund failed.');
    }
    const rf = r.refund;
    sendJson(res, 200, {
      replayed: Boolean(r.replayed),
      tokensRemoved: Number(r.tokensRemoved),
      refund: {
        id: Number(rf.id), orderId: Number(rf.order_id), amountRials: Number(rf.amount_rials),
        tokensRemoved: Number(rf.tokens_removed), reason: rf.reason, reference: rf.reference,
        actor: rf.actor, createdAt: ms(rf.created_at),
      },
      ...(r.order ? { order: publicOrderAdmin(r.order, await duplicateFlags([r.order])) } : {}),
    });
  });

  // ── finance console + analytics + analyst ────────────────────────────────
  registerFinanceRoutes(router, { db, cfg, guard });
  registerAnalyticsRoutes(router, { db, cfg, guard });

  // ── settings: card, packs, models, token config, finance staff ──────────
  router.get('/admin-api/settings', async (req, res) => {
    const session = await guard(req);
    const eff = await effectiveCaps(db, cfg, session.phone);
    sendJson(res, 200, {
      card: await getSetting(db, cfg, 'card'),
      packs: await getPacks(db, cfg),
      models: await getSetting(db, cfg, 'models'),
      tokenConfig: await getSetting(db, cfg, 'token_config'),
      financeStaff: eff?.role === 'owner' ? await getFinanceStaff(db, cfg) : null,
      smsProvider: cfg.smsProvider,
      smsTemplatesConfigured: Object.fromEntries(Object.entries(cfg.smsTemplates).map(([k, v]) => [k, Boolean(v)])),
    });
  });

  const putSetting = (key, action, validate) => async (req, res) => {
    const session = await guardCap('policy_write', { mutate: true })(req);
    const body = await readJson(req);
    const value = validate(body);
    await setSetting(db, key, value);
    await audit(db, session.phone, action, `settings:${key}`, null);
    sendJson(res, 200, { ok: true, [key]: value });
  };

  router.put('/admin-api/settings/card', putSetting('card', 'settings_card_updated', (b) => {
    if (typeof b.number !== 'string' || b.number.replace(/\D/g, '').length < 16) throw badRequest('invalid_card', 'Card number must be at least 16 digits.');
    return { number: b.number.trim(), holder: String(b.holder ?? ''), bank: String(b.bank ?? '') };
  }));

  router.put('/admin-api/settings/packs', async (req, res) => {
    const session = await guardCap('policy_write', { mutate: true })(req);
    const body = await readJson(req);
    if (!Array.isArray(body.packs) || body.packs.length > 8) throw badRequest('invalid_packs', 'packs must be an array (max 8).');
    const packs = body.packs.map((p) => {
      if (!p.id || !p.title || !(Number(p.usd) > 0)) throw badRequest('invalid_pack', 'Each pack needs id, title and usd > 0.');
      return {
        id: String(p.id), title: String(p.title), usd: Number(p.usd),
        priceRials: p.priceRials === null || p.priceRials === undefined ? null : Number(p.priceRials),
        validityDays: p.validityDays ? Number(p.validityDays) : null,
        badge: p.badge ? String(p.badge) : null,
        note: p.note ? String(p.note) : null,
      };
    });
    await setSetting(db, 'packs', packs);
    await audit(db, session.phone, 'settings_packs_updated', 'settings:packs', { count: packs.length });
    sendJson(res, 200, { ok: true, packs: await getPacks(db, cfg) });
  });

  router.put('/admin-api/settings/models', putSetting('models', 'settings_models_updated', (b) => {
    if (!Array.isArray(b.models)) throw badRequest('invalid_models', 'models must be an array.');
    return b.models.map((m) => {
      if (!m.model || !(Number(m.multiplier) >= 0)) throw badRequest('invalid_model', 'Each model needs a name and multiplier ≥ 0.');
      return { model: String(m.model), multiplier: Number(m.multiplier), enabled: m.enabled === false ? false : true };
    });
  }));

  router.put('/admin-api/settings/token-config', async (req, res) => {
    const session = await guardCap('policy_write', { mutate: true })(req);
    const body = await readJson(req);
    const tokensPerUsd = Number(body.tokensPerUsd);
    if (!(tokensPerUsd > 0)) throw badRequest('invalid_tokens_per_usd', 'tokensPerUsd must be > 0.');
    const current = await getSetting(db, cfg, 'token_config');
    const value = {
      tokensPerUsd,
      defaultMultiplier: Number(body.defaultMultiplier ?? current?.defaultMultiplier ?? 1),
      // Daily Rial-per-USD rate the owner works with (display/planning; pack
      // prices stay explicit per pack and are snapshotted at claim time).
      usdRialRate: body.usdRialRate === null || body.usdRialRate === undefined
        ? (current?.usdRialRate ?? null) : Number(body.usdRialRate),
    };
    if (value.usdRialRate !== null && !(value.usdRialRate > 0)) throw badRequest('invalid_usd_rial_rate', 'usdRialRate must be > 0.');
    await setSetting(db, 'token_config', value);
    await audit(db, session.phone, 'settings_token_config_updated', 'settings:token_config', null);
    sendJson(res, 200, { ok: true, tokenConfig: value });
  });

  router.put('/admin-api/settings/finance-staff', async (req, res) => {
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    if (!Array.isArray(body.staff)) throw badRequest('invalid_staff', 'staff must be an array.');
    const seen = new Set();
    const staff = body.staff.map((s) => {
      const phone = normalizePhone(String(s?.phone ?? ''));
      if (!phone) throw badRequest('invalid_staff_phone', 'Each staff member needs a valid Iranian mobile number.');
      if (seen.has(phone)) throw badRequest('duplicate_staff_phone', `Duplicate staff phone: ${phone}.`);
      seen.add(phone);
      return { phone, caps: sanitizeCaps(s.caps) };
    });
    await setSetting(db, 'finance_staff', staff);
    await audit(db, session.phone, 'settings_finance_staff_updated', 'settings:finance_staff', { count: staff.length });
    sendJson(res, 200, { ok: true, financeStaff: staff });
  });

  // ── audit ───────────────────────────────────────────────────────────────
  router.get('/admin-api/audit', async (req, res, { query }) => {
    await guardOwner()(req);
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    const offset = Math.max(Number(query.get('offset') || 0), 0);
    const actor = (query.get('actor') || '').trim();
    const action = (query.get('action') || '').trim();
    const where = [];
    const params = [];
    if (actor) { params.push(`%${actor}%`); where.push(`actor ILIKE $${params.length}`); }
    if (action) { params.push(action); where.push(`action = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.one(`SELECT count(*)::int AS c FROM public.admin_audit ${whereSql}`, params)).c;
    const rows = await db.many(
      `SELECT id, actor, action, target, meta, created_at FROM public.admin_audit ${whereSql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    sendJson(res, 200, {
      total,
      audit: rows.map((r) => ({
        id: Number(r.id), actor: r.actor, action: r.action, target: r.target,
        meta: r.meta ?? null, createdAt: ms(r.created_at),
      })),
    });
  });

  // ── static panel (React build output) ────────────────────────────────────
  const handler = withErrorHandling(async (req, res) => {
    const out = await router.handle(req, res, {});
    if (out !== null && out !== undefined) return out;
    if (req.method === 'GET' && !req.url.startsWith('/admin-api/')) {
      const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0];
      const file = path.join(DIST_DIR, rel);
      if (file.startsWith(DIST_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(data);
      }
      const index = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(index)) return sendHtml(res, 200, fs.readFileSync(index, 'utf8'));
      return sendHtml(res, 200, '<!doctype html><html lang="fa" dir="rtl"><body style="background:#090a0d;color:#eceef2;font-family:sans-serif;padding:2rem">پنل مدیریت هنوز بیلد نشده است — در پوشهٔ web/admin-panel دستور <code>npm run build</code> را اجرا کنید.</body></html>');
    }
    return null;
  });
  return http.createServer((req, res) => { void handler(req, res, {}); });
}
