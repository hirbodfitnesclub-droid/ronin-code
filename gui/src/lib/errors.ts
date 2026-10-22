/* Ronin Code — pure error-shaping helpers (unit-tested). */
import { ApiError } from './api';
import { ERROR_CODE_KEYS, type StringKey } from './i18n';

/** The dictionary key for a host ApiError with a stable code, else null. */
export function apiErrorKey(err: unknown): StringKey | null {
  if (err instanceof ApiError && err.code && ERROR_CODE_KEYS[err.code]) {
    return ERROR_CODE_KEYS[err.code];
  }
  return null;
}
