/* Ronin Code — pure mapping from host turn_error codes to the chat
   banner (unit-tested, no React). Behaviour-only Phase 2 addition:
   the relay's `account_suspended` code joins `subscription_locked`
   on the existing locked banner, and the provider's 402 (surfaced by
   the host as `insufficient_credit`) stays on the existing credit
   banner. Transient key-provisioning (`provider_key_not_ready`) and
   every other code get NO banner — the generic turn message shows. */

export type TurnBanner = 'credit' | 'locked';

export function bannerForTurnError(code: string | undefined | null): TurnBanner | null {
  if (code === 'insufficient_credit') return 'credit';
  if (code === 'subscription_locked' || code === 'account_suspended') return 'locked';
  return null;
}

/* Raw-payload defence (mirrors host util.looksLikeRawHtml): a text
   that IS — or, after a short status/prefix, contains — a raw HTML
   document is a fetched/provider error page, never chat prose. The
   host sanitises these before sending, but the chat maps any that
   still arrive to the localised generic turn error instead of
   rendering them. A leading ``` fence is an intentional code
   sample, not a payload. */
export function looksLikeRawHtml(text: string | undefined | null): boolean {
  if (!text) return false;
  const head = text.trimStart();
  if (head.startsWith('```')) return false;
  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head)) return true;
  const marker = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (marker > 0 && marker < 200) {
    const tags = text.match(/<[^>]+>/g);
    if (tags && tags.length >= 3) return true;
  }
  return false;
}

/** Text safe to show for a turn message: raw payloads become the fallback. */
export function safeTurnText(text: string, fallback: string): string {
  return looksLikeRawHtml(text) ? fallback : text;
}
