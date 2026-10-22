import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, withErrorHandling, sendJson, sendHtml, readJson, clientIp } from '../http.js';
import { normalizePhone, badRequest, notFound, ms } from '../util.js';
import { audit } from '../db.js';
import { getSetting, setSetting, getPacks } from '../settings.js';
import { ledgerBalance, adjustCredit, userLedger } from '../ledger.js';
import * as auth from '../auth.js';
import { listOrders, getOrder, reviewOrder, adminOrders } from '../orders.js';
import { createStorage } from '../storage.js';
import * as adminAuth from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * The STANDALONE admin application: its own HTTP server (ADMIN_PORT), its own
 * login page, its own session domain (admin_sessions + ronin_admin cookie +
 * per-session CSRF token). Nothing here is reachable through the user API.
 * Backed by the same Supabase Postgres as everything else; order reviews go
 * through the same atomic approve/reject RPCs as any other path.
 */
export function createAdminApp(db, cfg, sms) {
  const storage = createStorage(cfg);
  const router = createRouter();
  const guard = async (req, { mutate = false } = {}) => {
    const session = await adminAuth.authenticateAdmin(db, req);
    if (mutate) adminAuth.requireCsrf(session, req);
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
    await audit(db, phone, 'admin_login', 'admin', null);
    res.setHeader('Set-Cookie', adminAuth.adminCookieHeader(out.token, cfg.cookieSecure));
    sendJson(res, 200, { phone: out.phone, csrfToken: out.csrfToken });
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
    sendJson(res, 200, { phone: session.phone, csrfToken: session.csrf_token });
  });

  // ── dashboard ───────────────────────────────────────────────────────────
  router.get('/admin-api/overview', async (req, res) => {
    await guard(req);
    const users = (await db.one('SELECT count(*)::int AS c FROM public.users')).c;
    const revenue = Number((await db.one("SELECT COALESCE(SUM(received_amount_rials),0)::bigint AS s FROM public.orders WHERE status = 'approved'")).s);
    const pending = (await db.one("SELECT count(*)::int AS c FROM public.orders WHERE status = 'pending'")).c;
    const consumed = Number((await db.one("SELECT COALESCE(-SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind = 'consume'")).s);
    const granted = Number((await db.one("SELECT COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind IN ('purchase','adjust')")).s);
    sendJson(res, 200, { users, revenueRials: revenue, pendingOrders: pending, tokensConsumed: consumed, tokensGranted: granted });
  });

  // ── users ───────────────────────────────────────────────────────────────
  router.get('/admin-api/users', async (req, res, { query }) => {
    await guard(req);
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
    await guard(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const lotRows = await db.many('SELECT id, source, tokens_total, tokens_left, expires_at, created_at FROM public.credit_lots WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [user.id]);
    sendJson(res, 200, {
      user: { id: user.id, phone: user.phone, name: user.name, isActive: Boolean(user.is_active), createdAt: ms(user.created_at), lastLoginAt: ms(user.last_login_at) },
      balanceTokens: await ledgerBalance(db, user.id),
      ledger: await userLedger(db, user.id, 100),
      orders: await adminOrders(db, cfg, storage,
        await db.many('SELECT * FROM public.orders WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [user.id])),
      lots: lotRows.map((l) => ({
        id: Number(l.id), source: l.source,
        tokensTotal: Number(l.tokens_total), tokensLeft: Number(l.tokens_left),
        expiresAt: ms(l.expires_at), createdAt: ms(l.created_at),
      })),
    });
  });

  router.post('/admin-api/users/:id/toggle-active', async (req, res, { params }) => {
    const session = await guard(req, { mutate: true });
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
    const session = await guard(req, { mutate: true });
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

  // ── orders queue ────────────────────────────────────────────────────────
  // Every claim carries a receipt photo: responses include a short-lived
  // signed URL (`receiptUrl`) and `duplicateImage` (same photo on another
  // claim — a passive flag; the owner decides, nothing is auto-rejected).
  router.get('/admin-api/orders', async (req, res, { query }) => {
    await guard(req);
    const status = query.get('status');
    sendJson(res, 200, { orders: await adminOrders(db, cfg, storage, await listOrders(db, { status: status || null, limit: 200 })) });
  });

  router.get('/admin-api/orders/:id', async (req, res, { params }) => {
    await guard(req);
    const order = await getOrder(db, Number(params.id));
    if (!order) throw notFound('order_not_found', 'Order not found.');
    const user = await db.one('SELECT id, phone, name FROM public.users WHERE id = $1', [order.user_id]);
    const [enriched] = await adminOrders(db, cfg, storage, [{ ...order, user_phone: user?.phone }]);
    sendJson(res, 200, { order: enriched, user });
  });

  // Local-storage signed URLs resolve here (the signature IS the capability,
  // exactly like a Supabase signed URL — short-lived, no session needed).
  // With the Supabase backend, receiptUrl points at Supabase directly and
  // this route simply never matches a real object.
  router.get('/admin-api/receipt-file', async (req, res, { query }) => {
    const key = query.get('key');
    if (!storage.verifySignedParams(key, query.get('exp'), query.get('sig'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    const obj = await storage.read(key);
    if (!obj) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': obj.contentType, 'Content-Length': obj.buffer.length, 'Cache-Control': 'private, no-store' });
    return res.end(obj.buffer);
  });

  router.post('/admin-api/orders/:id/review', async (req, res, { params }) => {
    const session = await guard(req, { mutate: true });
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
    const [enriched] = await adminOrders(db, cfg, storage, [order]);
    sendJson(res, 200, { order: enriched, grantedTokens });
  });

  // ── settings: card, packs, models, token config ─────────────────────────
  router.get('/admin-api/settings', async (req, res) => {
    await guard(req);
    sendJson(res, 200, {
      card: await getSetting(db, cfg, 'card'),
      packs: await getPacks(db, cfg),
      models: await getSetting(db, cfg, 'models'),
      tokenConfig: await getSetting(db, cfg, 'token_config'),
      smsProvider: cfg.smsProvider,
      smsTemplatesConfigured: Object.fromEntries(Object.entries(cfg.smsTemplates).map(([k, v]) => [k, Boolean(v)])),
    });
  });

  const putSetting = (key, action, validate) => async (req, res) => {
    const session = await guard(req, { mutate: true });
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
    const session = await guard(req, { mutate: true });
    const body = await readJson(req);
    if (!Array.isArray(body.packs) || body.packs.length > 12) throw badRequest('invalid_packs', 'packs must be an array (max 12).');
    const packs = body.packs.map((p) => {
      if (!p.id || !p.title || !(Number(p.usd) > 0)) throw badRequest('invalid_pack', 'Each pack needs id, title and usd > 0.');
      return {
        id: String(p.id), title: String(p.title), usd: Number(p.usd),
        priceRials: p.priceRials === null || p.priceRials === undefined ? null : Number(p.priceRials),
        validityDays: p.validityDays ? Number(p.validityDays) : null,
        badge: p.badge ? String(p.badge) : null,
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
      return { model: String(m.model), multiplier: Number(m.multiplier) };
    });
  }));

  router.put('/admin-api/settings/token-config', putSetting('token_config', 'settings_token_config_updated', (b) => {
    const tokensPerUsd = Number(b.tokensPerUsd);
    if (!(tokensPerUsd > 0)) throw badRequest('invalid_tokens_per_usd', 'tokensPerUsd must be > 0.');
    return { tokensPerUsd, defaultMultiplier: Number(b.defaultMultiplier ?? 1) };
  }));

  // ── audit ───────────────────────────────────────────────────────────────
  router.get('/admin-api/audit', async (req, res, { query }) => {
    await guard(req);
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    const rows = await db.many('SELECT id, actor, action, target, meta, created_at FROM public.admin_audit ORDER BY id DESC LIMIT $1', [limit]);
    sendJson(res, 200, {
      audit: rows.map((r) => ({
        id: Number(r.id), actor: r.actor, action: r.action, target: r.target,
        meta: r.meta ?? null, createdAt: ms(r.created_at),
      })),
    });
  });

  // ── static panel ────────────────────────────────────────────────────────
  const handler = withErrorHandling(async (req, res) => {
    const out = await router.handle(req, res, {});
    if (out !== null && out !== undefined) return out;
    if (req.method === 'GET' && !req.url.startsWith('/admin-api/')) {
      const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(data);
      }
      return sendHtml(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    }
    return null;
  });
  return http.createServer((req, res) => { void handler(req, res, {}); });
}
