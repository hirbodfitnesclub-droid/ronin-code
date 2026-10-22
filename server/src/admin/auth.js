import { sha256Hex, randomToken, forbidden, unauthorized } from '../util.js';
import * as otp from './otp.js';
import { isAdminOrStaff } from './caps.js';

/**
 * Admin authentication — a SEPARATE domain from user auth:
 *  - OTP login restricted to the owner (ADMIN_PHONES) and finance staff
 *    (settings `finance_staff`), codes issued/verified by the admin-domain
 *    OTP module (not Supabase Auth). Capabilities are enforced per route.
 *  - Sessions live in `admin_sessions`, transported by the `ronin_admin` cookie.
 *  - User access/refresh tokens are never accepted here, and admin session
 *    tokens are meaningless on the user API (different tables, different checks).
 *  - Every state-changing admin call requires the session's CSRF token.
 */

export const ADMIN_COOKIE = 'ronin_admin';
export const ADMIN_SESSION_TTL_MS = 12 * 3_600_000; // 12 hours

export async function requestAdminOtp(db, cfg, sms, { phone, ip = '' }) {
  // Owner (ADMIN_PHONES) or finance staff (settings) may log in; caps are
  // enforced per-route afterwards (see caps.js).
  if (!(await isAdminOrStaff(db, cfg, phone))) throw forbidden('not_an_admin', 'This phone number is not an admin.');
  return otp.requestOtp(db, cfg, sms, { phone, ip });
}

export async function loginAdminWithOtp(db, cfg, { phone, code }) {
  if (!(await isAdminOrStaff(db, cfg, phone))) throw forbidden('not_an_admin', 'This phone number is not an admin.');
  await otp.verifyOtp(db, cfg, { phone, code });
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  await db.query('DELETE FROM public.admin_sessions WHERE phone = $1', [phone]); // one live admin session per admin phone
  await db.query(
    "INSERT INTO public.admin_sessions (token_hash, phone, csrf_token, expires_at) VALUES ($1,$2,$3, now() + ($4::bigint * interval '1 millisecond'))",
    [sha256Hex(token), phone, csrfToken, ADMIN_SESSION_TTL_MS]);
  return { token, csrfToken, phone };
}

export async function authenticateAdmin(db, req) {
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) throw unauthorized('admin_login_required', 'Admin login required.');
  const token = decodeURIComponent(cookie.slice(ADMIN_COOKIE.length + 1));
  const row = await db.one('SELECT * FROM public.admin_sessions WHERE token_hash = $1', [sha256Hex(token)]);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    throw unauthorized('admin_session_expired', 'Admin session expired.');
  }
  return row; // { phone, csrf_token, ... }
}

export function requireCsrf(session, req) {
  const presented = req.headers['x-csrf-token'];
  if (!presented || presented !== session.csrf_token) throw forbidden('csrf_failed', 'CSRF token missing or invalid.');
}

export async function logoutAdmin(db, token) {
  if (token) await db.query('DELETE FROM public.admin_sessions WHERE token_hash = $1', [sha256Hex(token)]);
}

export function adminCookieHeader(token, secure = false) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearAdminCookieHeader() {
  return `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}
