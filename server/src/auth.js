import crypto from 'node:crypto';
import { countInWindowOn, recordHitOn } from './ratelimit.js';
import { sha256Hex, minutes, days, badRequest, unauthorized, forbidden, tooMany, HttpError, ms } from './util.js';
import { log } from './log.js';

/**
 * Phone + OTP auth on Supabase Auth (GoTrue) — Ronin's approved design,
 * re-based in the Supabase migration:
 *
 *  - Identity, OTP generation/verification and JWT sessions live in Supabase
 *    Auth. OTPs are delivered by OUR Send SMS Hook (POST /hooks/send-sms),
 *    which sends them through Kavenegar — Kavenegar is not a built-in
 *    Supabase SMS provider.
 *  - GoTrue alone does NOT enforce two product rules, so this layer adds:
 *      · OTP brute-force lockout: max 5 wrong attempts, then the code is
 *        dead (public.otp_guards) — GoTrue tolerates unlimited tries.
 *      · Refresh-token rotation with REUSE DETECTION at our API boundary:
 *        every refresh token we hand out is registered by SHA-256 hash
 *        (public.device_refresh_tokens). Presenting a rotated-away token
 *        revokes the whole device session — GoTrue tolerates reuse inside
 *        its grace window, our invariant cannot.
 *  - Devices: max N concurrent devices (default 2); a login beyond the cap
 *    revokes the oldest device. The device registry is AUTHORITATIVE:
 *    authenticate() and the daily account-status check consult it on every
 *    call, so revocation/suspension bite immediately, not at token expiry.
 *  - Access tokens: 15 min (Auth JWT_EXP), verified locally by HS256 when
 *    SUPABASE_JWT_SECRET is configured, else via the Auth /user endpoint.
 */

export const OTP_TTL_MS = minutes(5);
export const OTP_MAX_ATTEMPTS = 5;
export const ACCESS_TTL_MS = minutes(15);
export const REFRESH_TTL_MS = days(30);

// ── phone formats ───────────────────────────────────────────────────────────
export const toE164 = (localPhone) => `+98${String(localPhone).slice(1)}`;
export function toLocalPhone(raw) {
  const s = String(raw ?? '').replace(/^\+/, '');
  return s.startsWith('98') && s.length === 12 ? `0${s.slice(2)}` : s;
}

// ── Supabase Auth (GoTrue) client ───────────────────────────────────────────
async function gotrue(cfg, path, { method = 'GET', token = null, body = null } = {}) {
  if (!cfg.supabaseAuthUrl) throw new HttpError(503, 'auth_not_configured', 'Auth server is not configured.');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.supabaseAnonKey) headers.apikey = cfg.supabaseAnonKey;
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${cfg.supabaseAuthUrl}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError(502, 'auth_unavailable', 'Auth server unreachable.');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json };
}

function signHs256(payload, secret) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * App-session access token (handoff devices only). GoTrue's generate_link
 * is email-only (verified on the pinned v2.197 binary), so the handoff
 * exchange mints OUR OWN sessions: an HS256 JWT over cfg.authSecret,
 * tagged ronin:'handoff', with the same 15-minute TTL as GoTrue tokens.
 * authenticate() verifies these FIRST, then applies the exact same
 * device-registry + user checks as the GoTrue path.
 */
export function signAppAccessToken(cfg, { userId, sessionId }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signHs256({
    sub: userId, session_id: sessionId, ronin: 'handoff',
    iat: nowSec, exp: Math.floor((Date.now() + ACCESS_TTL_MS) / 1000),
  }, cfg.authSecret);
}

function decodeJwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

function verifyHs256(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return decodeJwtPayload(token);
}

/** Best-effort hard kill of a GoTrue session (refresh tokens + session row).
 *  Our registry remains authoritative even if the Auth schema ever drifts. */
async function killGotrueSession(db, sessionId) {
  if (!sessionId) return;
  try {
    await db.query('DELETE FROM auth.refresh_tokens WHERE session_id = $1', [sessionId]);
    await db.query('DELETE FROM auth.sessions WHERE id = $1', [sessionId]);
  } catch (e) {
    log.warn('gotrue_session_kill_failed', { error: e.message });
  }
}

// ── OTP: request ────────────────────────────────────────────────────────────
export async function requestOtp(db, cfg, { phone, ip = '' }) {
  // Send rate limits (Shot's verified production posture): 60s cooldown,
  // 6/day per phone, 15/day per IP (anti SMS-pumping).
  // Check + send + record happen in ONE transaction under a per-phone
  // advisory lock, and hits are recorded only after the Auth server actually
  // accepted the send — a GoTrue-side rejection (its own SMS limiter) must
  // not burn the user's cooldown budget.
  const limits = [
    { key: `otp:min:${phone}`, limit: 1, windowMs: minutes(1), error: () => tooMany('otp_cooldown', 'Please wait a minute before requesting a new code.') },
    { key: `otp:day:${phone}`, limit: 6, windowMs: days(1), error: () => tooMany('otp_daily_limit', 'Daily code limit reached for this number.') },
    ...(ip ? [{ key: `otp:ip:${ip}`, limit: 15, windowMs: days(1), error: () => tooMany('otp_ip_limit', 'Too many code requests from this network.') }] : []),
  ];
  await db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp-send:${phone}`]);
    await client.query("DELETE FROM public.rate_events WHERE created_at < now() - interval '24 hours'");
    for (const l of limits) {
      if ((await countInWindowOn(client, l.key, l.windowMs)) >= l.limit) throw l.error();
    }
    const { status, json } = await gotrue(cfg, '/otp', {
      method: 'POST',
      body: { phone: toE164(phone), create_user: true, channel: 'sms' },
    });
    if (status === 429) throw tooMany('otp_cooldown', 'Please wait a minute before requesting a new code.');
    if (status < 200 || status >= 300) {
      log.error('gotrue_otp_failed', { status, error: json?.error_code ?? json?.msg ?? 'unknown' });
      throw new HttpError(502, 'otp_send_failed', 'Could not send the code. Try again.');
    }
    for (const l of limits) await recordHitOn(client, l.key);
    // Fresh code → fresh brute-force budget.
    await client.query(
      `INSERT INTO public.otp_guards (phone, fail_count, issued_at, locked, updated_at)
       VALUES ($1, 0, now(), false, now())
       ON CONFLICT (phone) DO UPDATE SET fail_count = 0, issued_at = now(), locked = false, updated_at = now()`,
      [phone]);
  });
  return { sent: true };
}

// ── OTP: verify (returns the GoTrue session) ────────────────────────────────
async function verifyOtpWithGotrue(db, cfg, { phone, code }) {
  const guard = await db.one('SELECT * FROM public.otp_guards WHERE phone = $1', [phone]);
  if (!guard || guard.locked) throw badRequest('otp_not_found', 'No active code for this number. Request a new one.');
  const nowMs = Date.now();
  if (guard.issued_at && nowMs - new Date(guard.issued_at).getTime() > cfg.otpTtlSeconds * 1000) {
    await db.query('UPDATE public.otp_guards SET locked = true, updated_at = now() WHERE phone = $1', [phone]);
    throw badRequest('otp_expired', 'This code has expired. Request a new one.');
  }
  const { status, json } = await gotrue(cfg, '/verify', {
    method: 'POST',
    body: { phone: toE164(phone), token: String(code).trim(), type: 'sms' },
  });
  if (status >= 200 && status < 300 && json?.access_token) {
    await db.query('DELETE FROM public.otp_guards WHERE phone = $1', [phone]);
    return json;
  }
  const fails = guard.fail_count + 1;
  await db.query(
    'UPDATE public.otp_guards SET fail_count = $2, locked = $3, updated_at = now() WHERE phone = $1',
    [phone, fails, fails >= OTP_MAX_ATTEMPTS]);
  const left = OTP_MAX_ATTEMPTS - fails;
  throw badRequest('otp_wrong', `Wrong code. ${Math.max(left, 0)} attempts left.`);
}

// ── Login: verify OTP, enforce device cap, register the session ─────────────
export async function loginWithOtp(db, cfg, { phone, code, deviceName = null, name = null }) {
  const session = await verifyOtpWithGotrue(db, cfg, { phone, code });
  const authUserId = session.user?.id;
  const payload = decodeJwtPayload(session.access_token);
  const sessionId = payload?.session_id ?? null;

  let user = await db.one('SELECT * FROM public.users WHERE id = $1', [authUserId]);
  if (!user) {
    // The auth.users trigger normally creates the profile at OTP-request
    // time; this is the belt-and-braces path if it ever lags.
    await db.query(
      'INSERT INTO public.users (id, phone, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [authUserId, phone, name]);
    user = await db.one('SELECT * FROM public.users WHERE id = $1', [authUserId]);
  } else if (name && !user.name) {
    await db.query('UPDATE public.users SET name = $2 WHERE id = $1', [user.id, name]);
    user.name = name;
  }
  if (!user.is_active) {
    await killGotrueSession(db, sessionId);
    throw forbidden('account_disabled', 'This account is disabled.');
  }

  const deviceId = await registerDevice(db, cfg, {
    user, sessionId, deviceName, kind: 'gotrue', refreshToken: session.refresh_token,
  });
  return {
    user: publicUser(user), deviceId,
    accessToken: session.access_token, refreshToken: session.refresh_token,
  };
}

/**
 * Device-cap enforcement + device row creation + refresh-hash registration,
 * shared by the GoTrue OTP login and the handoff exchange. `kind` records
 * which session domain the device belongs to ('gotrue' | 'handoff') so
 * refreshSession rotates through the right authority.
 */
export async function registerDevice(db, cfg, { user, sessionId, deviceName = null, kind = 'gotrue', refreshToken }) {
  // Device cap: revoke oldest active devices beyond (maxDevices - 1) to make room.
  const active = await db.many(
    'SELECT id FROM public.devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC',
    [user.id]);
  const excess = active.length - (cfg.maxDevices - 1);
  for (const d of active.slice(0, Math.max(0, excess))) {
    await revokeDeviceById(db, d.id);
  }
  const dev = await db.one(
    'INSERT INTO public.devices (user_id, auth_session_id, name, kind, last_seen_at) VALUES ($1,$2,$3,$4,now()) RETURNING id',
    [user.id, sessionId, deviceName, kind]);
  await db.query(
    'INSERT INTO public.device_refresh_tokens (device_id, token_hash) VALUES ($1,$2)',
    [dev.id, sha256Hex(refreshToken)]);
  await db.query('UPDATE public.users SET last_login_at = now() WHERE id = $1', [user.id]);
  return dev.id;
}

export function publicUser(u) {
  return {
    id: u.id, phone: u.phone, name: u.name, isActive: Boolean(u.is_active), createdAt: ms(u.created_at),
    onboarded: Boolean(u.onboarded), acquisitionSource: u.acquisition_source ?? null,
    onboardingGoal: u.onboarding_goal ?? null,
  };
}

// ── Authenticate an access token (user API only) ────────────────────────────
export async function authenticate(db, cfg, accessToken) {
  if (!accessToken) throw unauthorized();
  let payload = null;
  let userId = null;
  // App (handoff) tokens FIRST: HS256 over our own authSecret, tagged
  // ronin:'handoff'. A GoTrue token simply fails this HMAC and falls
  // through to the GoTrue path below, untouched.
  const appPayload = cfg.authSecret ? verifyHs256(accessToken, cfg.authSecret) : null;
  if (appPayload?.ronin === 'handoff') {
    payload = appPayload;
  } else if (cfg.supabaseJwtSecret) {
    payload = verifyHs256(accessToken, cfg.supabaseJwtSecret);
    if (!payload) throw unauthorized('invalid_token', 'Invalid access token.');
  } else {
    const { status, json } = await gotrue(cfg, '/user', { token: accessToken });
    if (status !== 200 || !json?.id) throw unauthorized('token_expired', 'Access token expired or invalid.');
    userId = json.id;
    payload = decodeJwtPayload(accessToken);
  }
  if (payload?.exp && payload.exp * 1000 <= Date.now()) {
    throw unauthorized('token_expired', 'Access token expired.');
  }
  userId = userId ?? payload?.sub;
  const sessionId = payload?.session_id;
  if (!userId || !sessionId) throw unauthorized('invalid_token', 'Invalid access token.');

  // The device registry is authoritative: a revoked device/session fails
  // here even if the JWT itself has not expired yet.
  const device = await db.one('SELECT * FROM public.devices WHERE auth_session_id = $1', [sessionId]);
  if (!device || device.user_id !== userId || device.revoked_at) {
    throw unauthorized('session_revoked', 'Session was revoked.');
  }
  const user = await db.one('SELECT * FROM public.users WHERE id = $1', [userId]);
  if (!user || !user.is_active) throw unauthorized('account_disabled', 'Account disabled or gone.');
  return { user, deviceId: device.id, sessionId, familyId: sessionId };
}

// ── Refresh: rotation + reuse detection at our boundary ─────────────────────
export async function refreshSession(db, cfg, refreshToken) {
  if (!refreshToken) throw unauthorized();
  const hash = sha256Hex(refreshToken);
  const reg = await db.one(
    `SELECT t.state, t.device_id, d.revoked_at AS device_revoked,
            d.user_id, d.auth_session_id, d.kind
     FROM public.device_refresh_tokens t
     JOIN public.devices d ON d.id = t.device_id
     WHERE t.token_hash = $1`,
    [hash]);
  if (!reg) throw unauthorized('invalid_refresh', 'Unknown refresh token.');
  if (reg.state === 'rotated') {
    // REUSE DETECTED: a rotated-away token was presented again → treat as theft.
    // The revocation is committed by revokeDeviceById BEFORE we throw.
    await revokeDeviceById(db, reg.device_id);
    throw unauthorized('refresh_reuse', 'Refresh token reuse detected. The whole session was revoked; log in again.');
  }
  if (reg.state === 'revoked' || reg.device_revoked) {
    throw unauthorized('session_revoked', 'Session was revoked.');
  }
  const user = await db.one('SELECT * FROM public.users WHERE id = $1', [reg.user_id]);
  if (!user || !user.is_active) throw unauthorized('account_disabled', 'Account disabled or gone.');

  if (reg.kind === 'handoff') {
    // App sessions rotate LOCALLY (GoTrue knows nothing about them): the
    // old token row is marked 'rotated' — so the reuse detection above
    // still fires if it is ever presented again — and a fresh pair is
    // minted under the same stable session id.
    await db.query(
      "UPDATE public.device_refresh_tokens SET state = 'rotated', rotated_at = now() WHERE token_hash = $1", [hash]);
    const newRefreshToken = crypto.randomBytes(32).toString('base64url');
    await db.query(
      'INSERT INTO public.device_refresh_tokens (device_id, token_hash) VALUES ($1,$2)',
      [reg.device_id, sha256Hex(newRefreshToken)]);
    await db.query('UPDATE public.devices SET last_seen_at = now() WHERE id = $1', [reg.device_id]);
    return {
      user: publicUser(user), deviceId: reg.device_id,
      accessToken: signAppAccessToken(cfg, { userId: reg.user_id, sessionId: reg.auth_session_id }),
      refreshToken: newRefreshToken,
    };
  }

  const { status, json } = await gotrue(cfg, '/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: refreshToken },
  });
  if (status < 200 || status >= 300 || !json?.access_token) {
    await db.query(
      "UPDATE public.device_refresh_tokens SET state = 'revoked' WHERE token_hash = $1", [hash]);
    const msg = String(json?.msg ?? json?.error_code ?? '');
    if (/expired/i.test(msg)) throw unauthorized('refresh_expired', 'Refresh token expired.');
    throw unauthorized('invalid_refresh', 'Refresh token rejected.');
  }

  await db.query(
    "UPDATE public.device_refresh_tokens SET state = 'rotated', rotated_at = now() WHERE token_hash = $1", [hash]);
  await db.query(
    'INSERT INTO public.device_refresh_tokens (device_id, token_hash) VALUES ($1,$2)',
    [reg.device_id, sha256Hex(json.refresh_token)]);
  const newSessionId = decodeJwtPayload(json.access_token)?.session_id;
  await db.query(
    'UPDATE public.devices SET last_seen_at = now(), auth_session_id = COALESCE($2, auth_session_id) WHERE id = $1',
    [reg.device_id, newSessionId ?? null]);
  return {
    user: publicUser(user), deviceId: reg.device_id,
    accessToken: json.access_token, refreshToken: json.refresh_token,
  };
}

// ── Handoff return codes (desktop app ← web panel login) ────────────────────
// The signed-in panel user asks for a code; the desktop app exchanges it
// once for a full app session. Codes are stored only as the SHA-256 of the
// normalized form (uppercase, dashes/spaces stripped) and live 10 minutes.
const HANDOFF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const HANDOFF_TTL_MS = minutes(10);

export function normalizeHandoffCode(code) {
  return String(code ?? '').toUpperCase().replace(/[-\s]/g, '');
}

export async function issueHandoffCode(db, userId) {
  // A fresh code supersedes every earlier unconsumed one for this user.
  await db.query(
    'UPDATE public.handoff_codes SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
    [userId]);
  const seg = () => Array.from({ length: 4 }, () => HANDOFF_ALPHABET[crypto.randomInt(HANDOFF_ALPHABET.length)]).join('');
  const code = `RNC-${seg()}-${seg()}`;
  await db.query(
    'INSERT INTO public.handoff_codes (user_id, code_hash, expires_at) VALUES ($1,$2,$3)',
    [userId, sha256Hex(normalizeHandoffCode(code)), new Date(Date.now() + HANDOFF_TTL_MS)]);
  return { code, expiresInSec: Math.floor(HANDOFF_TTL_MS / 1000) };
}

export async function exchangeHandoffCode(db, cfg, { code, deviceName = null }) {
  const hash = sha256Hex(normalizeHandoffCode(code));
  const row = await db.one(
    'SELECT * FROM public.handoff_codes WHERE code_hash = $1 ORDER BY created_at DESC LIMIT 1', [hash]);
  if (!row) throw badRequest('invalid_code', 'This return code is not recognized.');
  if (row.consumed_at) throw badRequest('code_used', 'This return code was already used.');
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw badRequest('code_expired', 'This return code has expired. Ask for a new one.');
  }
  // ATOMIC consume: exactly one exchange can win, even under a race.
  const consumed = await db.one(
    'UPDATE public.handoff_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
    [row.id]);
  if (!consumed) throw badRequest('code_used', 'This return code was already used.');
  const user = await db.one('SELECT * FROM public.users WHERE id = $1', [row.user_id]);
  if (!user || !user.is_active) throw forbidden('account_disabled', 'This account is disabled.');
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const deviceId = await registerDevice(db, cfg, {
    user, sessionId, deviceName, kind: 'handoff', refreshToken,
  });
  return {
    user: publicUser(user), deviceId,
    accessToken: signAppAccessToken(cfg, { userId: user.id, sessionId }),
    refreshToken,
  };
}

// ── Revocation / devices ────────────────────────────────────────────────────
export async function revokeDeviceById(db, deviceId) {
  const dev = await db.one('SELECT auth_session_id FROM public.devices WHERE id = $1', [deviceId]);
  await db.query(
    'UPDATE public.devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [deviceId]);
  await db.query(
    "UPDATE public.device_refresh_tokens SET state = 'revoked' WHERE device_id = $1 AND state <> 'revoked'",
    [deviceId]);
  await killGotrueSession(db, dev?.auth_session_id);
}

export async function revokeDevice(db, userId, deviceId) {
  const own = await db.one('SELECT id FROM public.devices WHERE id = $1 AND user_id = $2', [deviceId, userId]);
  if (own) await revokeDeviceById(db, deviceId);
}

export async function revokeSession(db, sessionId) {
  const dev = await db.one('SELECT id FROM public.devices WHERE auth_session_id = $1', [sessionId]);
  if (dev) await revokeDeviceById(db, dev.id);
}

export async function logoutAll(db, userId) {
  const devices = await db.many(
    'SELECT id FROM public.devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  for (const d of devices) await revokeDeviceById(db, d.id);
}

export async function listDevices(db, userId) {
  const rows = await db.many(
    'SELECT id, name, created_at, last_seen_at, revoked_at FROM public.devices WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]);
  return rows.map((d) => ({
    id: d.id, name: d.name,
    createdAt: ms(d.created_at), lastSeenAt: ms(d.last_seen_at),
    active: !d.revoked_at,
  }));
}

// ── Daily revalidation (account status) ─────────────────────────────────────
/** The single lightweight status the desktop app polls on launch + daily. */
export async function accountStatus(db, userId, deviceId) {
  const row = await db.one('SELECT public.account_status($1,$2) AS s', [userId, deviceId ?? null]);
  const s = row.s;
  if (!s.ok) throw unauthorized('account_disabled', 'Account disabled or gone.');
  return {
    serverTime: ms(s.serverTime),
    status: s.status,
    isActive: Boolean(s.isActive),
    balanceTokens: Number(s.balanceTokens),
    spendableTokens: Number(s.spendableTokens),
    lots: (s.lots ?? []).map((l) => ({
      id: Number(l.id), tokensLeft: Number(l.tokensLeft), expiresAt: ms(l.expiresAt),
    })),
    deviceAuthorized: Boolean(s.deviceAuthorized),
    activeDevices: Number(s.activeDevices),
  };
}
