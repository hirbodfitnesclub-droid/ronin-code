import crypto from 'node:crypto';
import { log } from '../log.js';
import { audit } from '../db.js';
import { decryptDelegatedKey } from './crypto.js';
import { getSetting } from '../settings.js';

/**
 * Reconciliation — design §8. Built ONLY from bounds, because the contract
 * offers no get-key endpoint:
 *   U = accumulated usage from logs polling (LOWER bound; gaps tracked),
 *   B = /v1/balance (UPPER bound on remaining; never a money input),
 *   L = token_limit_issued (our bookkeeping of confirmed ops).
 * Over-issuance (U + B > L + ε) flags immediately; under-issuance needs two
 * consecutive breaching polls. ε = max(100k, 1% of L). Drift flags are
 * deduped while open and NEVER auto-resolved.
 */

export const epsilonFor = (L) => Math.max(100_000, Math.floor(Number(L) * 0.01));

export function newestRowHash(logRow) {
  if (!logRow) return null;
  return crypto.createHash('sha256')
    .update([logRow.created_at, logRow.model, logRow.cost_tokens, logRow.latency_ms].join('|'))
    .digest('hex');
}

function tehranDay(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date(iso));
  } catch { return String(iso).slice(0, 10); }
}

export async function raiseDriftFlag(db, keyRow, note) {
  const open = await db.one(
    "SELECT id FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_drift' AND status = 'open'",
    [keyRow.user_id]);
  if (open) return false;
  await db.query(
    'INSERT INTO public.risk_flags (user_id, kind, note, created_by) VALUES ($1,$2,$3,$4)',
    [keyRow.user_id, 'provider_drift', String(note).slice(0, 500), 'system:reconciler']);
  return true;
}

export async function raiseAttentionFlag(db, userId, note) {
  const open = await db.one(
    "SELECT id FROM public.risk_flags WHERE user_id = $1 AND kind = 'provider_key_attention' AND status = 'open'",
    [userId]);
  if (open) return false;
  await db.query(
    'INSERT INTO public.risk_flags (user_id, kind, note, created_by) VALUES ($1,$2,$3,$4)',
    [userId, 'provider_key_attention', String(note).slice(0, 500), 'system:issuance']);
  return true;
}

/** One poll of one key: usage accumulation + balance cache + drift checks. */
export async function pollKey(db, cfg, client, keyRow) {
  if (!keyRow?.encrypted_key) return { polled: false, reason: 'no_key' };
  const plain = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: keyRow.user_id, keyRowId: keyRow.id });
  const [{ logs, total }, balance] = await Promise.all([
    client.getLogs(plain),
    client.getBalance(plain).catch(() => null),
  ]);
  const prevTotal = Number(keyRow.logs_total_seen ?? 0);
  let delta = Math.max(0, total - prevTotal);
  const hash = newestRowHash(logs[0]);
  let summedRows = logs.slice(0, Math.min(delta, 30));
  if (delta === 0 && hash && keyRow.logs_newest_hash && hash !== keyRow.logs_newest_hash && logs.length) {
    // Total-count lag guard (§8.3): newest row changed but total didn't.
    summedRows = logs.slice(0, 1);
    delta = 1;
  }
  const partial = (total - prevTotal) > 30;
  const gap = Math.max(0, (total - prevTotal) - 30);
  const tokensSummed = summedRows.reduce((s, r) => s + Number(r.cost_tokens ?? 0), 0);

  await db.query(
    `INSERT INTO public.key_usage_snapshots
       (user_id, user_provider_key_id, logs_total_seen, rows_summed, tokens_summed, partial, balance_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [keyRow.user_id, keyRow.id, total, summedRows.length, tokensSummed, partial, balance]);

  // Daily rollups per model (Tehran day) from the rows actually summed.
  const byModelDay = new Map();
  for (const r of summedRows) {
    const k = `${tehranDay(r.created_at)}|${r.model ?? 'unknown'}`;
    const cur = byModelDay.get(k) ?? { requests: 0, cost: 0 };
    cur.requests += 1; cur.cost += Number(r.cost_tokens ?? 0);
    byModelDay.set(k, cur);
  }
  for (const [k, v] of byModelDay) {
    const [day, model] = k.split('|');
    await db.query(
      `INSERT INTO public.key_usage_daily (user_id, day, model, requests, cost_tokens, partial)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, day, model) DO UPDATE SET
         requests = public.key_usage_daily.requests + excluded.requests,
         cost_tokens = public.key_usage_daily.cost_tokens + excluded.cost_tokens,
         partial = public.key_usage_daily.partial OR excluded.partial`,
      [keyRow.user_id, day, model, v.requests, v.cost, partial]);
  }

  const U = Number(keyRow.tokens_used_observed ?? 0) + tokensSummed;
  const L = Number(keyRow.token_limit_issued ?? 0);
  await db.query(
    `UPDATE public.user_provider_keys SET
       tokens_used_observed = $2, logs_total_seen = $3, logs_newest_hash = $4,
       logs_gap_rows = logs_gap_rows + $5,
       balance_observed = COALESCE($6, balance_observed),
       balance_observed_at = CASE WHEN $6 IS NULL THEN balance_observed_at ELSE now() END,
       last_reconciled_at = now(), updated_at = now()
     WHERE id = $1`,
    [keyRow.id, U, total, hash, gap, balance]);

  // ── Drift checks (§8.3) ────────────────────────────────────────────────
  let drift = null;
  if (balance !== null && L > 0) {
    const eps = epsilonFor(L);
    if (U + balance > L + eps) {
      drift = 'over_issuance';
      await db.query('UPDATE public.user_provider_keys SET under_breach_streak = 0 WHERE id = $1', [keyRow.id]);
      await raiseDriftFlag(db, keyRow,
        `over-issuance: L=${L} U=${U} B=${balance} eps=${eps} gapRows=${Number(keyRow.logs_gap_rows ?? 0) + gap}`);
    } else {
      // Gap allowance: unobserved rows × p95-ish per-request cost (own avg
      // bounded below by a 50k default when there is no history).
      const ownLogs = summedRows.length ? summedRows : logs;
      const avg = ownLogs.length
        ? ownLogs.reduce((s, r) => s + Number(r.cost_tokens ?? 0), 0) / ownLogs.length : 50_000;
      const perReq = Math.max(avg, 1);
      const gapAllowance = (Number(keyRow.logs_gap_rows ?? 0) + gap) * perReq;
      const under = balance < L - U - eps - gapAllowance;
      if (under) {
        const streak = Number(keyRow.under_breach_streak ?? 0) + 1;
        await db.query('UPDATE public.user_provider_keys SET under_breach_streak = $2 WHERE id = $1', [keyRow.id, streak]);
        if (streak >= 2) {
          drift = 'under_issuance';
          await raiseDriftFlag(db, keyRow,
            `under-issuance (2 consecutive): L=${L} U=${U} B=${balance} eps=${eps} gapAllowance=${Math.round(gapAllowance)}`);
        }
      } else {
        await db.query('UPDATE public.user_provider_keys SET under_breach_streak = 0 WHERE id = $1', [keyRow.id]);
      }
    }
  }
  return { polled: true, tokensSummed, total, balance, partial, drift };
}

/** Periodic sweep (§8.4): least-recently-reconciled first, batch of ≤50. */
export async function reconcileSweep(db, cfg, client, { limit = 50 } = {}) {
  const rows = await db.many(
    `SELECT * FROM public.user_provider_keys
     WHERE encrypted_key IS NOT NULL AND status IN ('active','frozen','needs_attention')
     ORDER BY last_reconciled_at ASC NULLS FIRST LIMIT $1`, [limit]);
  let ok = 0; let failed = 0;
  for (const row of rows) {
    try { await pollKey(db, cfg, client, row); ok++; }
    catch (e) { failed++; log.warn('reconcile_key_failed', { keyRowId: Number(row.id), error: e.message }); }
  }
  if (rows.length && failed === rows.length) log.error('reconcile_sweep_failed', { attempted: rows.length });
  await poolHealth(db, cfg, client).catch((e) => log.warn('pool_health_failed', { error: e.message }));
  return { attempted: rows.length, ok, failed };
}

/** Pool gauge from the primary key's balance (§8.5) — audit + analyst only. */
export async function poolHealth(db, cfg, client) {
  if (!cfg.cvcPrimaryApiKey || !cfg.cvcBaseUrl) return null;
  const pool = await client.getBalance(cfg.cvcPrimaryApiKey);
  const agg = await db.one(
    `SELECT COALESCE(SUM(token_limit_issued - tokens_used_observed),0)::bigint AS outstanding
     FROM public.user_provider_keys WHERE status IN ('active','frozen','needs_attention') AND encrypted_key IS NOT NULL`);
  const outstanding = Number(agg.outstanding);
  const floorDoc = await getSetting(db, cfg, 'provider_pool').catch(() => null);
  const floor = Number(floorDoc?.floorTokens ?? 0);
  const low = pool < outstanding * 0.2 || (floor > 0 && pool < floor);
  if (low) {
    const recent = await db.one(
      "SELECT id FROM public.admin_audit WHERE action = 'provider_pool_low' AND created_at > now() - interval '1 hour' LIMIT 1");
    if (!recent) {
      await audit(db, 'system', 'provider_pool_low', 'provider', { poolObserved: pool, outstanding });
    }
  }
  return { poolObserved: pool, outstanding, low };
}
