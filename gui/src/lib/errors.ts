/* Ronin Code — pure error-shaping helpers (unit-tested).
   Imports use explicit `.ts` extensions (type-only for the dictionary)
   so this module loads under the Node test runner as well as Vite;
   `allowImportingTsExtensions` is on in tsconfig. */
import { ApiError, isErrorCodeToken } from './api.ts';
import { looksLikeRawHtml } from './turnErrors.ts';
import type { StringKey } from './i18n/en.ts';

/** Host error codes → dictionary keys (host messages stay English as fallback). */
export const ERROR_CODE_KEYS: Record<string, StringKey> = {
  no_project: 'errors.no_project',
  prompt_required: 'errors.prompt_required',
  turn_running: 'errors.turn_running',
  budget_exceeded: 'errors.budget_exceeded',
  no_snapshot: 'errors.no_snapshot',
  not_found: 'errors.not_found',
};

/** The dictionary key for a host ApiError with a stable code, else null. */
export function apiErrorKey(err: unknown): StringKey | null {
  if (err instanceof ApiError && err.code && ERROR_CODE_KEYS[err.code]) {
    return ERROR_CODE_KEYS[err.code];
  }
  return null;
}

export type TranslateFn = (key: StringKey, vars?: Record<string, string | number>) => string;

/* Browser / runtime error text that is NOT authored for users: fetch
   TypeErrors, JSON parse errors and aborts differ per browser and read
   as jargon ("Failed to fetch", "Load failed", "Unexpected token …").
   They must collapse to the localised fallback, never reach the screen. */
const BROWSER_ERROR_TEXT =
  /failed to fetch|fetch failed|load failed|network\s?error|network request failed|internet connection appears to be offline|unexpected token|unexpected end of json|is not valid json|the operation was aborted|aborterror/i;

/**
 * True only for a message a human actually wrote for the user: a
 * multi-word sentence that is not a raw error code, not raw HTML, not a
 * raw JSON payload, not a synthetic `… failed (NNN)` status string and
 * not browser/runtime error text.
 */
export function isHumanErrorMessage(message: unknown): message is string {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text) return false;
  /* Via a boolean local: calling the type guard directly on an
     already-`string` value would narrow `text` to `never` below. */
  const codeShaped: boolean = isErrorCodeToken(text);
  if (codeShaped) return false;
  /* A single token is never a sentence — this also rejects raw codes
     without underscores and lone status words. */
  if (!/\s/.test(text)) return false;
  if (looksLikeRawHtml(text)) return false;
  if (text.startsWith('{') || text.startsWith('[')) return false;
  /* Synthetic status strings produced locally, e.g. the former
     `Request failed (500)` in lib/api and `Export failed (404)` in
     api.exportZip — a status number is not a next step. */
  if (/\bfailed\s*\(\d+\)/i.test(text)) return false;
  if (BROWSER_ERROR_TEXT.test(text)) return false;
  return true;
}

/**
 * The one display path for a caught error (INVARIANT: the user only
 * ever sees a human message — never a raw code, raw HTML, a status
 * string or browser error text):
 *   1. a mapped host code → its localised string;
 *   2. else the error's message, ONLY when it is a genuine human
 *      sentence (see isHumanErrorMessage);
 *   3. else the localised fallback (`errors.unknown` by default).
 */
export function humanErrorText(err: unknown, t: TranslateFn, fallbackKey: StringKey = 'errors.unknown'): string {
  const key = apiErrorKey(err);
  if (key) return t(key);
  if (err instanceof Error && isHumanErrorMessage(err.message)) return err.message.trim();
  return t(fallbackKey);
}
