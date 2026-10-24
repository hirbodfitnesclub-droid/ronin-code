/* Ronin Code — pure helpers for the segmented auth inputs
   (unit-tested, no React). The handoff return code is issued by the
   server as `RNC-XXXX-XXXX`: two 4-char segments from an alphabet
   without 0/O/1/I/L, normalised server-side by uppercasing and
   stripping dashes/spaces. The OTP is 6 digits. */

/** Characters of one handoff-code body (8 chars, no prefix). */
export const HANDOFF_CODE_LENGTH = 8;
export const OTP_LENGTH = 6;

/**
 * Normalise pasted/typed handoff-code text to the 8-char body:
 * uppercase, keep alphanumerics only, drop a leading `RNC` prefix
 * when the pasted text carried one (11+ chars), cap at 8.
 */
export function normalizeHandoffCode(raw: string): string {
  let s = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (s.length > HANDOFF_CODE_LENGTH && s.startsWith('RNC')) s = s.slice(3);
  return s.slice(0, HANDOFF_CODE_LENGTH);
}

/** The display form the app sends back: `RNC-XXXX-XXXX`. */
export function formatHandoffCode(body: string): string {
  const b = normalizeHandoffCode(body);
  if (b.length <= 4) return `RNC-${b}`;
  return `RNC-${b.slice(0, 4)}-${b.slice(4)}`;
}

export function handoffCodeComplete(body: string): boolean {
  return normalizeHandoffCode(body).length === HANDOFF_CODE_LENGTH;
}

/** Normalise OTP input: digits only, capped at 6. */
export function normalizeOtp(raw: string): string {
  return String(raw ?? '')
    .replace(/\D/g, '')
    .slice(0, OTP_LENGTH);
}

export function otpComplete(code: string): boolean {
  return normalizeOtp(code).length === OTP_LENGTH;
}
