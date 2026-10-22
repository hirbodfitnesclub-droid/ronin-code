import crypto from 'node:crypto';
import { hitRateLimit } from '../ratelimit.js';
import { hmacHex, timingSafeEqualStr, minutes, days, badRequest, tooMany } from '../util.js';

/**
 * Admin-domain OTP — deliberately NOT Supabase Auth.
 *
 * The standalone admin app keeps its own login + session domain (owner
 * decision): codes live in public.otp_codes (purpose 'admin_login'),
 * HMAC-hashed at rest, 5-minute expiry, max 5 attempts, strict send rate
 * limits — the exact semantics the pre-migration server had. User OTPs, by
 * contrast, are generated/verified by Supabase Auth and delivered through
 * the Send SMS Hook (see src/auth.js).
 */

export const OTP_TTL_MS = minutes(5);
export const OTP_MAX_ATTEMPTS = 5;
const PURPOSE = 'admin_login';

export async function requestOtp(db, cfg, sms, { phone, ip = '' }) {
  if (!(await hitRateLimit(db, `otp:min:${phone}`, 1, minutes(1)))) throw tooMany('otp_cooldown', 'Please wait a minute before requesting a new code.');
  if (!(await hitRateLimit(db, `otp:day:${phone}`, 5, days(1)))) throw tooMany('otp_daily_limit', 'Daily code limit reached for this number.');
  if (ip && !(await hitRateLimit(db, `otp:ip:${ip}`, 20, days(1)))) throw tooMany('otp_ip_limit', 'Too many code requests from this network.');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = hmacHex(cfg.authSecret, `${phone}:${PURPOSE}:${code}`);
  await db.tx(async (client) => {
    await client.query(
      'UPDATE public.otp_codes SET consumed = true WHERE phone = $1 AND purpose = $2 AND consumed = false',
      [phone, PURPOSE]);
    await client.query(
      "INSERT INTO public.otp_codes (phone, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + ($4::bigint * interval '1 millisecond'))",
      [phone, PURPOSE, codeHash, OTP_TTL_MS]);
  });
  await sms.sendOtp(phone, code);
  return { sent: true };
}

export async function verifyOtp(db, cfg, { phone, code }) {
  const row = await db.one(
    `SELECT *, (expires_at <= now()) AS expired FROM public.otp_codes
     WHERE phone = $1 AND purpose = $2 AND consumed = false ORDER BY id DESC LIMIT 1`,
    [phone, PURPOSE]);
  if (!row) throw badRequest('otp_not_found', 'No active code for this number. Request a new one.');
  if (row.expired) {
    await db.query('UPDATE public.otp_codes SET consumed = true WHERE id = $1', [row.id]);
    throw badRequest('otp_expired', 'This code has expired. Request a new one.');
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('otp_locked', 'Too many wrong attempts. Request a new code.');
  const candidate = hmacHex(cfg.authSecret, `${phone}:${PURPOSE}:${String(code).trim()}`);
  if (!timingSafeEqualStr(candidate, row.code_hash)) {
    const attempts = row.attempts + 1;
    await db.query('UPDATE public.otp_codes SET attempts = $2 WHERE id = $1', [row.id, attempts]);
    const left = OTP_MAX_ATTEMPTS - attempts;
    if (left <= 0) await db.query('UPDATE public.otp_codes SET consumed = true WHERE id = $1', [row.id]);
    throw badRequest('otp_wrong', `Wrong code. ${Math.max(left, 0)} attempts left.`);
  }
  await db.query('UPDATE public.otp_codes SET consumed = true WHERE id = $1', [row.id]);
  return true;
}
