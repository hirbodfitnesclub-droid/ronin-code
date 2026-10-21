import crypto from 'node:crypto';
import { tx } from './db.js';
import { hitRateLimit } from './ratelimit.js';
import { hmacHex, sha256Hex, timingSafeEqualStr, randomToken, minutes, days, badRequest, unauthorized, forbidden, tooMany } from './util.js';

/**
 * Phone + OTP auth (Ronin's approved design — see README "Deviation from Liro"):
 *  - OTP: 6 digits, HMAC-SHA256 hashed at rest, 5-min expiry, max 5 attempts,
 *    strict send rate limits (anti SMS-pumping).
 *  - Sessions: 15-min opaque access token + 30-day refresh token WITH rotation
 *    and reuse detection — reusing a rotated refresh token kills the whole family.
 *  - Devices: max N concurrent devices (default 2); a login beyond the cap
 *    revokes the oldest device. Remote logout per device or for all devices.
 */

export const OTP_TTL_MS = minutes(5);
export const OTP_MAX_ATTEMPTS = 5;
export const ACCESS_TTL_MS = minutes(15);
export const REFRESH_TTL_MS = days(30);

export function requestOtp(db, cfg, sms, { phone, purpose = 'login', ip = '' }) {
  // Send rate limits: 60s cooldown, 5/day per phone, 20/day per IP (Liro-grade, tightened per security review).
  if (!hitRateLimit(db, `otp:min:${phone}`, 1, minutes(1))) throw tooMany('otp_cooldown', 'Please wait a minute before requesting a new code.');
  if (!hitRateLimit(db, `otp:day:${phone}`, 5, days(1))) throw tooMany('otp_daily_limit', 'Daily code limit reached for this number.');
  if (ip && !hitRateLimit(db, `otp:ip:${ip}`, 20, days(1))) throw tooMany('otp_ip_limit', 'Too many code requests from this network.');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = hmacHex(cfg.authSecret, `${phone}:${purpose}:${code}`);
  tx(db, () => {
    db.prepare("UPDATE otp_codes SET consumed = 1 WHERE phone = ? AND purpose = ? AND consumed = 0").run(phone, purpose);
    db.prepare('INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
      .run(phone, purpose, codeHash, Date.now() + OTP_TTL_MS, Date.now());
  });
  return sms.sendOtp(phone, code).then(() => ({ sent: true }));
}

export function verifyOtp(db, cfg, { phone, code, purpose = 'login' }) {
  const row = db.prepare(
    'SELECT * FROM otp_codes WHERE phone = ? AND purpose = ? AND consumed = 0 ORDER BY id DESC LIMIT 1'
  ).get(phone, purpose);
  if (!row) throw badRequest('otp_not_found', 'No active code for this number. Request a new one.');
  if (row.expires_at <= Date.now()) {
    db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
    throw badRequest('otp_expired', 'This code has expired. Request a new one.');
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('otp_locked', 'Too many wrong attempts. Request a new code.');
  const candidate = hmacHex(cfg.authSecret, `${phone}:${purpose}:${String(code).trim()}`);
  if (!timingSafeEqualStr(candidate, row.code_hash)) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = OTP_MAX_ATTEMPTS - (row.attempts + 1);
    if (left <= 0) db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
    throw badRequest('otp_wrong', `Wrong code. ${Math.max(left, 0)} attempts left.`);
  }
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return true;
}

function issueTokens(db, userId, familyId) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  db.prepare('INSERT INTO access_tokens (token_hash, user_id, family_id, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(sha256Hex(accessToken), userId, familyId, Date.now() + ACCESS_TTL_MS, Date.now());
  const info = db.prepare('INSERT INTO refresh_tokens (family_id, token_hash, expires_at, created_at) VALUES (?,?,?,?)')
    .run(familyId, sha256Hex(refreshToken), Date.now() + REFRESH_TTL_MS, Date.now());
  return { accessToken, refreshToken, refreshId: Number(info.lastInsertRowid) };
}

/** Verify OTP and open a session on a (possibly new) device. */
export function loginWithOtp(db, cfg, { phone, code, deviceName = null, name = null }) {
  verifyOtp(db, cfg, { phone, code, purpose: 'login' });
  return tx(db, () => {
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const info = db.prepare('INSERT INTO users (phone, name, created_at) VALUES (?,?,?)').run(phone, name, Date.now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
    } else if (name && !user.name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
      user.name = name;
    }
    if (!user.is_active) throw forbidden('account_disabled', 'This account is disabled.');

    // Device cap: revoke oldest active devices beyond (maxDevices - 1) to make room.
    const activeDevices = db.prepare(`
      SELECT d.id FROM devices d JOIN token_families f ON f.device_id = d.id
      WHERE d.user_id = ? AND d.revoked_at IS NULL AND f.revoked_at IS NULL
      GROUP BY d.id ORDER BY MAX(f.created_at) ASC`).all(user.id);
    const toRevoke = activeDevices.slice(0, Math.max(0, activeDevices.length - (cfg.maxDevices - 1)));
    for (const d of toRevoke) revokeDevice(db, user.id, d.id, 'device_cap');

    const dev = db.prepare('INSERT INTO devices (user_id, name, created_at, last_seen_at) VALUES (?,?,?,?)')
      .run(user.id, deviceName, Date.now(), Date.now());
    const deviceId = Number(dev.lastInsertRowid);
    const fam = db.prepare('INSERT INTO token_families (user_id, device_id, created_at) VALUES (?,?,?)')
      .run(user.id, deviceId, Date.now());
    const familyId = Number(fam.lastInsertRowid);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    const tokens = issueTokens(db, user.id, familyId);
    return { user: publicUser(user), deviceId, ...tokens };
  });
}

export function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, isActive: Boolean(u.is_active), createdAt: u.created_at };
}

/** Resolve an access token → user (user API only; admin tokens are a separate table/domain). */
export function authenticate(db, accessToken) {
  if (!accessToken) throw unauthorized();
  const row = db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?').get(sha256Hex(accessToken));
  if (!row || row.expires_at <= Date.now()) throw unauthorized('token_expired', 'Access token expired.');
  const fam = db.prepare('SELECT * FROM token_families WHERE id = ?').get(row.family_id);
  if (!fam || fam.revoked_at) throw unauthorized('session_revoked', 'Session was revoked.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || !user.is_active) throw unauthorized('account_disabled', 'Account disabled or gone.');
  return { user, familyId: row.family_id };
}

/** Rotate a refresh token. Reuse of an already-rotated token kills the family. */
export function refreshSession(db, refreshToken) {
  if (!refreshToken) throw unauthorized();
  const hash = sha256Hex(refreshToken);
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash);
    if (!row) throw unauthorized('invalid_refresh', 'Unknown refresh token.');
    const fam = db.prepare('SELECT * FROM token_families WHERE id = ?').get(row.family_id);
    if (!fam || fam.revoked_at) throw unauthorized('session_revoked', 'Session was revoked.');
    if (row.replaced_by_id || row.used_at) {
      // REUSE DETECTED: a rotated-away token was presented again → treat as theft.
      revokeFamily(db, fam.id, 'refresh_reuse_detected');
      throw unauthorized('refresh_reuse', 'Refresh token reuse detected. The whole session family was revoked; log in again.');
    }
    if (row.expires_at <= Date.now()) throw unauthorized('refresh_expired', 'Refresh token expired.');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(fam.user_id);
    if (!user || !user.is_active) throw unauthorized('account_disabled', 'Account disabled or gone.');
    const tokens = issueTokens(db, user.id, fam.id);
    db.prepare('UPDATE refresh_tokens SET used_at = ?, replaced_by_id = ? WHERE id = ?').run(Date.now(), tokens.refreshId, row.id);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), fam.device_id);
    return { user: publicUser(user), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  });
}

export function revokeFamily(db, familyId, reason = 'logout') {
  db.prepare('UPDATE token_families SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), reason, familyId);
  db.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(familyId);
}

export function revokeDevice(db, userId, deviceId, reason = 'remote_logout') {
  const fams = db.prepare('SELECT id FROM token_families WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL').all(userId, deviceId);
  for (const f of fams) revokeFamily(db, f.id, reason);
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?').run(Date.now(), deviceId, userId);
}

export function listDevices(db, userId) {
  return db.prepare(`
    SELECT d.id, d.name, d.created_at AS createdAt, d.last_seen_at AS lastSeenAt,
           MAX(CASE WHEN f.revoked_at IS NULL THEN 1 ELSE 0 END) AS active
    FROM devices d LEFT JOIN token_families f ON f.device_id = d.id
    WHERE d.user_id = ? GROUP BY d.id ORDER BY d.id DESC`).all(userId)
    .map((d) => ({ ...d, active: Boolean(d.active) }));
}

export function logoutAll(db, userId) {
  const fams = db.prepare('SELECT id FROM token_families WHERE user_id = ? AND revoked_at IS NULL').all(userId);
  for (const f of fams) revokeFamily(db, f.id, 'logout_all');
  db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId);
}
