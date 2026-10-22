import { ApiError } from '../../lib/api';
import { ERROR_CODE_KEYS, type StringKey } from '../../lib/i18n';

/* Auth helpers — digit normalisation, phone formatting, error mapping. */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Persian / Arabic-Indic digits → Latin, everything else non-digit dropped. */
export function normalizeDigits(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const fa = FA_DIGITS.indexOf(ch);
    const ar = AR_DIGITS.indexOf(ch);
    if (fa >= 0) out += String(fa);
    else if (ar >= 0) out += String(ar);
    else if (ch >= '0' && ch <= '9') out += ch;
  }
  return out;
}

export function isValidPhone(phone: string): boolean {
  return /^09\d{9}$/.test(phone);
}

/** Grouped display for the phone input: 0912 345 6789 (partial-safe). */
export function formatPhoneDisplay(digits: string): string {
  const d = digits.slice(0, 11);
  const parts = [d.slice(0, 4), d.slice(4, 7), d.slice(7, 11)].filter(Boolean);
  return parts.join(' ');
}

/** Masked phone for the OTP step: 0912 *** 6789. */
export function maskPhone(phone: string): string {
  if (phone.length !== 11) return phone;
  return `${phone.slice(0, 4)} *** ${phone.slice(7)}`;
}

/** Simple device label for the session, e.g. `Web Panel · Windows`. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  let os = 'Web';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return `Web Panel · ${os}`;
}

const EXTRA_CODE_KEYS: Record<string, StringKey> = {
  network: 'errors.network',
  session_expired: 'errors.sessionExpired',
  unauthorized: 'errors.sessionExpired',
};

/** Map any thrown error to a localized dictionary key. */
export function errorKeyFor(e: unknown): StringKey {
  if (e instanceof ApiError) {
    return ERROR_CODE_KEYS[e.code] ?? EXTRA_CODE_KEYS[e.code] ?? 'errors.unknown';
  }
  return 'errors.unknown';
}

/** True when the panel was opened from the desktop app (?from=app, persisted). */
export function detectFromApp(): boolean {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('from') === 'app';
    if (fromUrl) {
      sessionStorage.setItem('ronin.panel.fromApp', '1');
      return true;
    }
    return sessionStorage.getItem('ronin.panel.fromApp') === '1';
  } catch {
    return new URLSearchParams(window.location.search).get('from') === 'app';
  }
}

/** mm:ss for the resend countdown. */
export function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
