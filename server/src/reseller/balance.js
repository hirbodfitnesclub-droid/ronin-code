import { decryptDelegatedKey } from './crypto.js';
import { createResellerClient } from './client.js';

/**
 * Provider balance reads — design §7.1. Cached on user_provider_keys
 * (balance_observed/at), 60 s TTL; past TTL a refresh is attempted with an
 * 800 ms soft deadline — on timeout/failure the stale value is served
 * (flagged) for up to 24 h, after which the balance is reported as
 * unavailable rather than as a wrong number. NEVER a money input (§8.2).
 */

export const BALANCE_TTL_MS = 60_000;
export const BALANCE_STALE_MAX_MS = 24 * 3_600_000;

export async function getProviderBalance(db, cfg, keyRow, { client = createResellerClient(cfg), force = false } = {}) {
  if (!keyRow?.encrypted_key) return { balance: null, stale: false, unavailable: true };
  const age = keyRow.balance_observed_at ? Date.now() - new Date(keyRow.balance_observed_at).getTime() : Infinity;
  if (!force && keyRow.balance_observed !== null && keyRow.balance_observed !== undefined && age < BALANCE_TTL_MS) {
    return { balance: Number(keyRow.balance_observed), stale: false, unavailable: false };
  }
  try {
    const plain = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: keyRow.user_id, keyRowId: keyRow.id });
    const fresh = await Promise.race([
      client.getBalance(plain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('balance_soft_deadline')), 800)),
    ]);
    await db.query(
      'UPDATE public.user_provider_keys SET balance_observed = $2, balance_observed_at = now(), updated_at = now() WHERE id = $1',
      [keyRow.id, fresh]);
    return { balance: Number(fresh), stale: false, unavailable: false };
  } catch {
    if (keyRow.balance_observed !== null && keyRow.balance_observed !== undefined && age < BALANCE_STALE_MAX_MS) {
      return { balance: Number(keyRow.balance_observed), stale: true, unavailable: false };
    }
    return { balance: null, stale: false, unavailable: true };
  }
}
