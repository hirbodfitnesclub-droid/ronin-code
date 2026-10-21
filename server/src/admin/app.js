import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, withErrorHandling, sendJson, sendHtml, readJson, clientIp } from '../http.js';
import { normalizePhone, badRequest, notFound } from '../util.js';
import { audit } from '../db.js';
import { getSetting, setSetting, getPacks } from '../settings.js';
import { ledgerBalance, adjustCredit, userLedger } from '../ledger.js';
import { revokeFamily } from '../auth.js';
import { listOrders, getOrder, reviewOrder, publicOrder } from '../orders.js';
import * as adminAuth from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * The STANDALONE admin application: its own HTTP server (ADMIN_PORT), its own
 * login page, its own session domain (admin_sessions + ronin_admin cookie +
 * per-session CSRF token). Nothing here is reachable through the user API.
 */
export function createAdminApp(db, cfg, sms) {
  const router = createRouter();
  const guard = (req, { mutate = false } = {}) => {
    const session = adminAuth.authenticateAdmin(db, req);
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
    const out = adminAuth.loginAdminWithOtp(db, cfg, { phone, code: String(body.code) });
    audit(db, phone, 'admin_login', 'admin', null);
    res.setHeader('Set-Cookie', adminAuth.adminCookieHeader(out.token, cfg.cookieSecure));
    sendJson(res, 200, { phone: out.phone, csrfToken: out.csrfToken });
  });

  router.post('/admin-api/auth/logout', async (req, res) => {
    const session = guard(req, { mutate: true });
    const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${adminAuth.ADMIN_COOKIE}=`));
    adminAuth.logoutAdmin(db, cookie ? decodeURIComponent(cookie.slice(adminAuth.ADMIN_COOKIE.length + 1)) : null);
    audit(db, session.phone, 'admin_logout', 'admin', null);
    res.setHeader('Set-Cookie', adminAuth.clearAdminCookieHeader());
    sendJson(res, 200, { ok: true });
  });

  router.get('/admin-api/session', async (req, res) => {
    const session = guard(req);
    sendJson(res, 200, { phone: session.phone, csrfToken: session.csrf_token });
  });

  // ── dashboard ───────────────────────────────────────────────────────────
  router.get('/admin-api/overview', async (req, res) => {
    guard(req);
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const revenue = db.prepare("SELECT COALESCE(SUM(received_amount_rials),0) AS s FROM orders WHERE status = 'approved'").get().s;
    const pending = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'").get().c;
    const consumed = db.prepare("SELECT COALESCE(-SUM(delta_tokens),0) AS s FROM ledger WHERE kind = 'consume'").get().s;
    const granted = db.prepare("SELECT COALESCE(SUM(delta_tokens),0) AS s FROM ledger WHERE kind IN ('purchase','adjust')").get().s;
    sendJson(res, 200, { users, revenueRials: revenue, pendingOrders: pending, tokensConsumed: consumed, tokensGranted: granted });
  });

  // ── users ───────────────────────────────────────────────────────────────
  router.get('/admin-api/users', async (req, res, { query }) => {
    guard(req);
    const search = (query.get('search') || '').trim();
    const rows = search
      ? db.prepare('SELECT * FROM users WHERE phone LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 100').all(`%${search}%`, `%${search}%`)
      : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 100').all();
    sendJson(res, 200, {
      users: rows.map((u) => ({
        id: u.id, phone: u.phone, name: u.name, isActive: Boolean(u.is_active),
        balanceTokens: ledgerBalance(db, u.id), createdAt: u.created_at, lastLoginAt: u.last_login_at,
      })),
    });
  });

  router.get('/admin-api/users/:id', async (req, res, { params }) => {
    guard(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!user) throw notFound('user_not_found', 'User not found.');
    const lots = db.prepare('SELECT id, source, tokens_total AS tokensTotal, tokens_left AS tokensLeft, expires_at AS expiresAt, created_at AS createdAt FROM credit_lots WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id);
    sendJson(res, 200, {
      user: { id: user.id, phone: user.phone, name: user.name, isActive: Boolean(user.is_active), createdAt: user.created_at, lastLoginAt: user.last_login_at },
      balanceTokens: ledgerBalance(db, user.id),
      ledger: userLedger(db, user.id, 100),
      orders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id).map(publicOrder),
      lots,
    });
  });

  router.post('/admin-api/users/:id/toggle-active', async (req, res, { params }) => {
    const session = guard(req, { mutate: true });
    const body = await readJson(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!user) throw notFound('user_not_found', 'User not found.');
    const active = body.isActive === undefined ? !user.is_active : Boolean(body.isActive);
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, user.id);
    if (!active) { // disabling also kills live sessions
      const fams = db.prepare('SELECT id FROM token_families WHERE user_id = ? AND revoked_at IS NULL').all(user.id);
      for (const f of fams) revokeFamily(db, f.id, 'account_disabled');
    }
    audit(db, session.phone, active ? 'user_activated' : 'user_deactivated', `user:${user.id}`, null);
    sendJson(res, 200, { ok: true, isActive: active });
  });

  router.post('/admin-api/users/:id/charge', async (req, res, { params }) => {
    const session = guard(req, { mutate: true });
    const body = await readJson(req);
    const tokens = Number(body.tokens);
    // Four-eyes culture (Liro): a manual balance change is impossible without a written note.
    if (!body.note || String(body.note).trim().length < 3) throw badRequest('note_required', 'A note (reason) is required for manual charges.');
    if (!Number.isInteger(tokens) || tokens === 0) throw badRequest('invalid_tokens', 'tokens must be a non-zero integer (negative = debit).');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!user) throw notFound('user_not_found', 'User not found.');
    const balanceAfter = adjustCredit(db, {
      userId: user.id, tokens, actor: `admin:${session.phone}`, note: String(body.note),
    });
    audit(db, session.phone, 'user_manual_charge', `user:${user.id}`, { tokens, note: String(body.note) });
    sendJson(res, 200, { ok: true, balanceTokens: balanceAfter });
  });

  // ── orders queue ────────────────────────────────────────────────────────
  router.get('/admin-api/orders', async (req, res, { query }) => {
    guard(req);
    const status = query.get('status');
    sendJson(res, 200, { orders: listOrders(db, { status: status || null, limit: 200 }).map(publicOrder) });
  });

  router.get('/admin-api/orders/:id', async (req, res, { params }) => {
    guard(req);
    const order = getOrder(db, Number(params.id));
    if (!order) throw notFound('order_not_found', 'Order not found.');
    const user = db.prepare('SELECT id, phone, name FROM users WHERE id = ?').get(order.user_id);
    sendJson(res, 200, { order: publicOrder({ ...order, user_phone: user?.phone }), user });
  });

  router.post('/admin-api/orders/:id/review', async (req, res, { params }) => {
    const session = guard(req, { mutate: true });
    const body = await readJson(req);
    const before = getOrder(db, Number(params.id));
    if (!before) throw notFound('order_not_found', 'Order not found.');
    const { order, grantedTokens } = reviewOrder(db, cfg, session.phone, before.id, {
      action: body.action,
      receivedAmountRials: body.receivedAmountRials,
      reason: body.reason, note: body.note,
    });
    // Liro-style SMS follow-up (fire-and-forget; templates from env).
    const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(order.user_id);
    if (user) {
      if (order.status === 'approved') void sms.sendPackageActivated(user.phone, grantedTokens, order.pack_title);
      else if (order.status === 'rejected') void sms.sendOrderRejected(user.phone, order.reject_reason);
    }
    sendJson(res, 200, { order: publicOrder(order), grantedTokens });
  });

  // ── settings: card, packs, models, token config ─────────────────────────
  router.get('/admin-api/settings', async (req, res) => {
    guard(req);
    sendJson(res, 200, {
      card: getSetting(db, cfg, 'card'),
      packs: getPacks(db, cfg),
      models: getSetting(db, cfg, 'models'),
      tokenConfig: getSetting(db, cfg, 'token_config'),
      smsProvider: cfg.smsProvider,
      smsTemplatesConfigured: Object.fromEntries(Object.entries(cfg.smsTemplates).map(([k, v]) => [k, Boolean(v)])),
    });
  });

  const putSetting = (key, action, validate) => async (req, res) => {
    const session = guard(req, { mutate: true });
    const body = await readJson(req);
    const value = validate(body);
    setSetting(db, key, value);
    audit(db, session.phone, action, `settings:${key}`, null);
    sendJson(res, 200, { ok: true, [key]: value });
  };

  router.put('/admin-api/settings/card', putSetting('card', 'settings_card_updated', (b) => {
    if (typeof b.number !== 'string' || b.number.replace(/\D/g, '').length < 16) throw badRequest('invalid_card', 'Card number must be at least 16 digits.');
    return { number: b.number.trim(), holder: String(b.holder ?? ''), bank: String(b.bank ?? '') };
  }));

  router.put('/admin-api/settings/packs', async (req, res) => {
    const session = guard(req, { mutate: true });
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
    setSetting(db, 'packs', packs);
    audit(db, session.phone, 'settings_packs_updated', 'settings:packs', { count: packs.length });
    sendJson(res, 200, { ok: true, packs: getPacks(db, cfg) });
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
    guard(req);
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    const rows = db.prepare('SELECT id, actor, action, target, meta, created_at AS createdAt FROM admin_audit ORDER BY id DESC LIMIT ?').all(limit);
    sendJson(res, 200, { audit: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) });
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
