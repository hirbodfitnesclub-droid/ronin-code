import crypto from 'node:crypto';

export const now = () => Date.now();
export const minutes = (n) => n * 60_000;
export const days = (n) => n * 86_400_000;

/** pg returns timestamptz as Date (rows) or ISO string (jsonb) and int8 as string — normalize at the API edge. */
export const ms = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : Number(v));
export const num = (v) => (v === null || v === undefined ? null : Number(v));

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacHex(secret, value) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Liro semantics: Persian/Arabic digits → Latin, +98/0098/98 prefixes → 09xxxxxxxxx. */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim()
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\s-]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  return /^09\d{9}$/.test(s) ? s : null;
}

export function isAdminPhone(cfg, phone) {
  return Boolean(phone) && cfg.adminPhones.includes(phone);
}

/** Error with an HTTP status and a stable machine code. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (code, msg) => new HttpError(400, code, msg);
export const unauthorized = (code = 'unauthorized', msg) => new HttpError(401, code, msg);
export const forbidden = (code = 'forbidden', msg) => new HttpError(403, code, msg);
export const notFound = (code = 'not_found', msg) => new HttpError(404, code, msg);
export const conflict = (code, msg) => new HttpError(409, code, msg);
export const tooMany = (code = 'rate_limited', msg) => new HttpError(429, code, msg);
export const paymentRequired = (code, msg) => new HttpError(402, code, msg);
