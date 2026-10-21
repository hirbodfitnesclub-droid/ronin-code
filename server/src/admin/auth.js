import { sha256Hex, randomToken, forbidden, unauthorized, isAdminPhone } from '../util.js';
import * as auth from '../auth.js';

/**
 * Admin authentication — a SEPARATE domain from user auth:
 *  - OTP login restricted to phones in ADMIN_PHONES (Liro owner semantics).
 *  - Sessions live in `admin_sessions`, transported by the `ronin_admin` cookie.
 *  - User access/refresh tokens are never accepted here, and admin session
 *    tokens are meaningless on the user API (different tables, different checks).
 *  - Every state-changing admin call requires the session's CSRF token.
 */

export const ADMIN_COOKIE = 'ronin_admin';
export const ADMIN_SESSION_TTL_MS = 12 * 3_600_000; // 12 hours

export function requestAdminOtp(db, cfg, sms, { phone, ip = '' }) {
  if (!isAdminPhone(cfg, phone)) throw forbidden('not_an_admin', 'This phone number is not an admin.');
  return auth.requestOtp(db, cfg, sms, { phone, purpose: 'admin_login', ip });
}

export function loginAdminWithOtp(db, cfg, { phone, code }) {
  if (!isAdminPhone(cfg, phone)) throw forbidden('not_an_admin', 'This phone number is not an admin.');
  auth.verifyOtp(db, cfg, { phone, code, purpose: 'admin_login' });
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  db.prepare('DELETE FROM admin_sessions WHERE phone = ?').run(phone); // one live admin session per admin phone
  db.prepare('INSERT INTO admin_sessions (token_hash, phone, csrf_token, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(sha256Hex(token), phone, csrfToken, Date.now() + ADMIN_SESSION_TTL_MS, Date.now());
  return { token, csrfToken, phone };
}

export function authenticateAdmin(db, req) {
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) throw unauthorized('admin_login_required', 'Admin login required.');
  const token = decodeURIComponent(cookie.slice(ADMIN_COOKIE.length + 1));
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(sha256Hex(token));
  if (!row || row.expires_at <= Date.now()) throw unauthorized('admin_session_expired', 'Admin session expired.');
  return row; // { phone, csrf_token, ... }
}

export function requireCsrf(session, req) {
  const presented = req.headers['x-csrf-token'];
  if (!presented || presented !== session.csrf_token) throw forbidden('csrf_failed', 'CSRF token missing or invalid.');
}

export function logoutAdmin(db, token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256Hex(token));
}

export function adminCookieHeader(token, secure = false) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearAdminCookieHeader() {
  return `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}
