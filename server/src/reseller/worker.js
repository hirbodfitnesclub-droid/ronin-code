import { log } from '../log.js';
import { audit } from '../db.js';
import { createResellerClient, ResellerError } from './client.js';
import { encryptDelegatedKey, decryptDelegatedKey, fingerprintOf, last4Of, encryptionReady } from './crypto.js';
import { breakerOpen, setBreaker, getKeyRow, effectivePerUser } from './routing.js';
import { insertIntent, ensureKeyShell } from './intents.js';
import { raiseAttentionFlag, reconcileSweep } from './reconcile.js';

/**
 * Issuance worker — design §3.3/§3.4.
 *  - Claims intents with SELECT … FOR UPDATE SKIP LOCKED (multi-process safe).
 *  - Per-user FIFO (freeze jumps the queue; it is state-setting + safety).
 *  - Coalescing ONLY before first dispatch: pending topups fold into a
 *    pending create for the same user.
 *  - Ambiguous mutation outcomes are NEVER auto-retried: create/topup →
 *    needs_attention; idempotent ops (reduce/freeze/unfreeze/delete) may
 *    retry with the STORED target / same effect.
 *  - A crashed in_flight lease (>120 s) reclaims mutations to
 *    needs_attention, idempotent ops back to pending.
 *  - 401/403 control-plane failures open the issuance circuit breaker.
 */

const INSTANCE = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const IDEMPOTENT_KINDS = new Set(['reduce', 'freeze', 'unfreeze', 'delete']);

export function backoffMs(cfg, attemptCount, retryAfterMs = null) {
  if (retryAfterMs) return retryAfterMs;
  const base = cfg.resellerBackoffBaseMs ?? 30_000;
  return Math.min(base * 2 ** Math.max(0, attemptCount - 1), 30 * 60_000);
}

async function appendAttempt(db, intent, entry) {
  const attempts = [...(intent.attempts ?? []), entry].slice(-20);
  await db.query('UPDATE public.key_issuance_intents SET attempts = $2, updated_at = now() WHERE id = $1',
    [intent.id, JSON.stringify(attempts)]);
  return attempts;
}

async function setIntent(db, intent, patch) {
  const cols = [];
  const vals = [intent.id];
  for (const [k, v] of Object.entries(patch)) { vals.push(v); cols.push(`${k} = $${vals.length}`); }
  cols.push('updated_at = now()');
  await db.query(`UPDATE public.key_issuance_intents SET ${cols.join(', ')} WHERE id = $1`, vals);
}

export function createWorker(db, cfg, client = createResellerClient(cfg)) {
  async function reclaimStale() {
    const stale = await db.many(
      `SELECT * FROM public.key_issuance_intents
       WHERE state = 'in_flight' AND locked_at < now() - interval '120 seconds'`);
    for (const i of stale) {
      if (IDEMPOTENT_KINDS.has(i.kind)) {
        await setIntent(db, i, { state: 'pending', locked_at: null, locked_by: null, next_attempt_at: new Date() });
      } else {
        await setIntent(db, i, { state: 'needs_attention', locked_at: null, locked_by: null });
        await raiseAttentionFlag(db, i.user_id, `intent ${i.id} (${i.kind}) lease expired with unknown provider outcome`);
      }
    }
    return stale.length;
  }

  async function claimNext() {
    return db.tx(async (clientPg) => {
      const r = await clientPg.query(
        `SELECT * FROM public.key_issuance_intents
         WHERE state = 'pending' AND next_attempt_at <= now()
         ORDER BY (kind = 'freeze') DESC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`);
      const intent = r.rows[0];
      if (!intent) return null;
      // Per-user FIFO: a non-freeze intent may not overtake an earlier live
      // intent for the same user (the claimed row is the earliest by the
      // ORDER BY unless it is a freeze, which is allowed to jump).
      await clientPg.query(
        `UPDATE public.key_issuance_intents
         SET state = 'in_flight', locked_at = now(), locked_by = $2,
             attempt_count = attempt_count + 1, updated_at = now()
         WHERE id = $1`, [intent.id, INSTANCE]);
      return { ...intent, state: 'in_flight', attempt_count: Number(intent.attempt_count) + 1 };
    });
  }

  async function coalesce(intent) {
    if (intent.kind !== 'create' && intent.kind !== 'convert') return intent;
    if (Number(intent.attempt_count) > 1) return intent; // already dispatched once — never rewrite arithmetic
    // Fold later pending create/topup intents into this create/convert: the
    // §9.3 pair (convert of the old balance + the claim's topup) must land
    // as ONE provider create with the summed limit.
    const topups = await db.many(
      `SELECT * FROM public.key_issuance_intents
       WHERE user_id = $1 AND kind IN ('topup','create') AND state = 'pending' AND id > $2 ORDER BY id`,
      [intent.user_id, intent.id]);
    if (!topups.length) return intent;
    let amount = Number(intent.amount_tokens ?? 0);
    for (const t of topups) {
      amount += Number(t.amount_tokens ?? 0);
      await appendAttempt(db, t, { at: new Date().toISOString(), action: 'coalesced', note: `folded into intent ${intent.id}` });
      await setIntent(db, t, { state: 'superseded', completed_at: new Date() });
    }
    await setIntent(db, intent, { amount_tokens: amount });
    return { ...intent, amount_tokens: amount };
  }

  async function markNeedsAttention(intent, err, note = null) {
    await appendAttempt(db, intent, {
      at: new Date().toISOString(), action: intent.kind,
      httpStatus: err?.status ?? intent.provider_http_status ?? null,
      errorCode: err?.code ?? null, note: note ?? err?.classification ?? 'ambiguous',
    });
    await setIntent(db, intent, {
      state: 'needs_attention',
      provider_http_status: err?.status ?? null, provider_error_code: err?.code ?? null,
      locked_at: null, locked_by: null,
    });
    await raiseAttentionFlag(db, intent.user_id,
      `intent ${intent.id} (${intent.kind}, ${intent.amount_tokens ?? ''} tokens) needs attention: ${err?.code ?? note ?? 'ambiguous outcome'}`);
  }

  async function handleFailure(intent, err) {
    const cls = err instanceof ResellerError ? err.classification : 'ambiguous';
    await appendAttempt(db, intent, {
      at: new Date().toISOString(), action: intent.kind,
      httpStatus: err?.status ?? null, errorCode: err?.code ?? err?.message ?? null, note: cls,
    }).catch(() => {});
    if (err?.primaryGuard) {
      await audit(db, 'system', 'provider_primary_guard_tripped', `user:${intent.user_id}`, { intentId: Number(intent.id) }).catch(() => {});
      await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'primary_guard' });
      return;
    }
    if (cls === 'auth_terminal') {
      await setIntent(db, intent, {
        state: 'failed', completed_at: new Date(),
        provider_http_status: err.status, provider_error_code: err.code,
      });
      await audit(db, 'system', 'provider_control_plane_auth_failed', 'provider', { intentId: Number(intent.id), status: err.status }).catch(() => {});
      await setBreaker(db, true, { reason: err.code ?? 'auth', intentId: Number(intent.id) });
      log.error('provider_control_plane_auth_failed', { intentId: Number(intent.id) });
      return;
    }
    if (cls === 'not_found') {
      if (intent.kind === 'delete') return confirmIntent(intent, { note: 'delete_404_already_gone' });
      return markNeedsAttention(intent, err, 'not_found');
    }
    if (cls === 'safe_retry') {
      await setIntent(db, intent, {
        state: 'pending', locked_at: null, locked_by: null,
        next_attempt_at: new Date(Date.now() + backoffMs(cfg, intent.attempt_count, err.retryAfterMs)),
        provider_http_status: err.status, provider_error_code: err.code,
      });
      return;
    }
    if (cls === 'terminal') {
      await setIntent(db, intent, {
        state: 'failed', completed_at: new Date(),
        provider_http_status: err.status, provider_error_code: err.code,
      });
      return;
    }
    // ambiguous
    if (IDEMPOTENT_KINDS.has(intent.kind) && intent.attempt_count < 3) {
      await setIntent(db, intent, {
        state: 'pending', locked_at: null, locked_by: null,
        next_attempt_at: new Date(Date.now() + backoffMs(cfg, intent.attempt_count)),
        provider_http_status: err?.status ?? null, provider_error_code: err?.code ?? null,
      });
      return;
    }
    return markNeedsAttention(intent, err);
  }

  async function confirmIntent(intent, { note = null } = {}) {
    await appendAttempt(db, intent, { at: new Date().toISOString(), action: intent.kind, note: note ?? 'confirmed' });
    await setIntent(db, intent, { state: 'confirmed', completed_at: new Date(), locked_at: null, locked_by: null });
    // Auto-resolve the attention flag when no other attention intent remains.
    const remaining = await db.one(
      "SELECT count(*)::int AS c FROM public.key_issuance_intents WHERE user_id = $1 AND state = 'needs_attention'",
      [intent.user_id]);
    if (remaining.c === 0) {
      await db.query(
        "UPDATE public.risk_flags SET status = 'resolved', resolved_by = 'system:issuance', resolved_at = now() WHERE user_id = $1 AND kind = 'provider_key_attention' AND status = 'open'",
        [intent.user_id]);
    }
  }

  async function decryptedFor(keyRow) {
    return decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: keyRow.user_id, keyRowId: keyRow.id });
  }

  async function snapshotBefore(intent, keyRow) {
    if (intent.balance_before !== null && intent.balance_before !== undefined) return;
    try {
      const plain = await decryptedFor(keyRow);
      const bal = await client.getBalance(plain);
      await setIntent(db, intent, {
        balance_before: bal, used_before: Number(keyRow.tokens_used_observed ?? 0),
      });
    } catch { /* snapshot is evidence, not a precondition */ }
  }

  async function execute(intent) {
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [intent.user_id]);
    if (!user) { await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'user_not_found' }); return; }

    // §3.3/§10 row 7: never provision for a suspended user — cancel pending
    // create/topup/convert; freeze proceeds (it IS the suspension mirror).
    if (!user.is_active && ['create', 'topup', 'convert'].includes(intent.kind)) {
      await appendAttempt(db, intent, { at: new Date().toISOString(), action: intent.kind, note: 'cancelled_user_suspended' });
      await setIntent(db, intent, { state: 'cancelled', completed_at: new Date() });
      return;
    }

    let keyRow = await getKeyRow(db, intent.user_id);
    if (!keyRow) keyRow = await ensureKeyShell(db, intent.user_id);

    try {
      switch (intent.kind) {
        case 'create':
        case 'convert': {
          if (keyRow.encrypted_key) {
            if (intent.kind === 'create') {
              await setIntent(db, intent, { state: 'superseded', completed_at: new Date() });
              return;
            }
            // convert with an existing key = additive top-up of the frozen amount
            await snapshotBefore(intent, keyRow);
            const plain = await decryptedFor(keyRow);
            await client.editKey({
              targetKey: plain, expectedFingerprint: keyRow.key_fingerprint,
              fields: { additional_tokens: Number(intent.amount_tokens) },
            });
            await db.query(
              'UPDATE public.user_provider_keys SET token_limit_issued = token_limit_issued + $2, updated_at = now() WHERE id = $1',
              [keyRow.id, Number(intent.amount_tokens)]);
            return confirmIntent(intent);
          }
          const amount = Number(intent.amount_tokens ?? 0);
          if (amount <= 0) { await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'invalid_amount' }); return; }
          const nameRow = await getKeyRow(db, intent.user_id);
          const out = await client.createKey({ name: nameRow.provider_key_name, tokenLimit: amount });
          await setIntent(db, intent, { state: 'issued' });
          const metaLimit = Number(out.meta.token_limit ?? amount);
          const ciphertext = encryptDelegatedKey(cfg, out.key, { userId: intent.user_id, keyRowId: keyRow.id });
          await db.query(
            `UPDATE public.user_provider_keys SET
               encrypted_key = $2, key_fingerprint = $3, key_last4 = $4,
               token_limit_issued = $5, status = 'active', allowed_models = '"all"'::jsonb,
               tokens_used_observed = $6, updated_at = now()
             WHERE id = $1`,
            [keyRow.id, ciphertext, fingerprintOf(out.key), last4Of(out.key), metaLimit, Number(out.meta.tokens_used ?? 0)]);
          if (metaLimit !== amount) {
            return markNeedsAttention(intent,
              new ResellerError('ambiguous', { code: 'limit_mismatch' }),
              `meta.token_limit ${metaLimit} != requested ${amount}; key is active`);
          }
          return confirmIntent(intent);
        }
        case 'topup': {
          if (!keyRow.encrypted_key) { // create must happen first (FIFO normally guarantees it)
            await setIntent(db, intent, { state: 'pending', next_attempt_at: new Date(Date.now() + backoffMs(cfg, 1)) });
            return;
          }
          await snapshotBefore(intent, keyRow);
          const plain = await decryptedFor(keyRow);
          await client.editKey({
            targetKey: plain, expectedFingerprint: keyRow.key_fingerprint,
            fields: { additional_tokens: Number(intent.amount_tokens) },
          });
          await db.query(
            'UPDATE public.user_provider_keys SET token_limit_issued = token_limit_issued + $2, updated_at = now() WHERE id = $1',
            [keyRow.id, Number(intent.amount_tokens)]);
          return confirmIntent(intent);
        }
        case 'reduce': {
          if (!keyRow.encrypted_key) { await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'no_key' }); return; }
          let target = intent.target_token_limit !== null && intent.target_token_limit !== undefined
            ? Number(intent.target_token_limit)
            : Number(keyRow.token_limit_issued) - Number(intent.amount_tokens ?? 0);
          const usedFloor = Number(keyRow.tokens_used_observed ?? 0);
          if (target < usedFloor) {
            target = usedFloor;
            await appendAttempt(db, intent, { at: new Date().toISOString(), action: 'reduce', note: `clamped_to_used_${usedFloor}` });
          }
          target = Math.max(target, 0);
          await setIntent(db, intent, { target_token_limit: target });
          const plain = await decryptedFor(keyRow);
          await client.editKey({
            targetKey: plain, expectedFingerprint: keyRow.key_fingerprint,
            fields: { token_limit: target },
          });
          await db.query('UPDATE public.user_provider_keys SET token_limit_issued = $2, updated_at = now() WHERE id = $1',
            [keyRow.id, target]);
          return confirmIntent(intent);
        }
        case 'freeze':
        case 'unfreeze': {
          if (!keyRow.encrypted_key) { await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'no_key' }); return; }
          const plain = await decryptedFor(keyRow);
          await client.editKey({
            targetKey: plain, expectedFingerprint: keyRow.key_fingerprint,
            fields: { active: intent.kind === 'unfreeze' },
          });
          await db.query('UPDATE public.user_provider_keys SET status = $2, updated_at = now() WHERE id = $1',
            [keyRow.id, intent.kind === 'freeze' ? 'frozen' : 'active']);
          return confirmIntent(intent);
        }
        case 'delete': {
          if (!keyRow.encrypted_key) {
            await db.query("UPDATE public.user_provider_keys SET status = 'deleted', updated_at = now() WHERE id = $1", [keyRow.id]);
            return confirmIntent(intent, { note: 'no_key_to_delete' });
          }
          // Contract rule: explicit admin confirmation before first dispatch —
          // the close flow records the admin actor on the intent.
          if (!intent.actor || !String(intent.actor).startsWith('admin:')) {
            await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'delete_confirmation_missing' });
            return;
          }
          const plain = await decryptedFor(keyRow);
          await client.editKey({
            targetKey: plain, expectedFingerprint: keyRow.key_fingerprint,
            fields: { delete: true },
          });
          await db.query(
            `UPDATE public.user_provider_keys SET status = 'deleted', encrypted_key = NULL,
               key_fingerprint = NULL, key_last4 = NULL, updated_at = now() WHERE id = $1`,
            [keyRow.id]);
          return confirmIntent(intent);
        }
        default:
          await setIntent(db, intent, { state: 'failed', completed_at: new Date(), provider_error_code: 'unknown_kind' });
      }
    } catch (e) {
      await handleFailure(intent, e);
    }
  }

  /** Backfill sweeper (§3.1 step 3): anti-join money events → missing intents. */
  async function sweepBackfill() {
    let inserted = 0;
    // Approved claims (granted amount = the ledger purchase delta).
    const orders = await db.many(
      `SELECT o.id, o.user_id, l.delta_tokens AS granted
       FROM public.orders o
       JOIN public.ledger l ON l.idempotency_key = 'order-approve:' || o.id::text
       WHERE o.status IN ('approved','refunded')
         AND NOT EXISTS (SELECT 1 FROM public.key_issuance_intents i WHERE i.idempotency_key = 'claim-issuance:' || o.id::text)`);
    for (const o of orders) {
      if (!(await effectivePerUser(db, cfg, o.user_id))) continue;
      const keyRow = await getKeyRow(db, o.user_id);
      const kind = keyRow?.encrypted_key ? 'topup' : 'create';
      // Skip when the total already issued covers all approved grants.
      const issued = Number(keyRow?.token_limit_issued ?? 0);
      const totalRow = await db.one(
        `SELECT COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger
         WHERE user_id = $1 AND kind = 'purchase'`, [o.user_id]);
      if (issued >= Number(totalRow.s) && keyRow?.encrypted_key) continue;
      await insertIntent(db, {
        userId: o.user_id, kind, source: 'claim', orderId: Number(o.id),
        ledgerIdempotencyKey: `order-approve:${o.id}`,
        idempotencyKey: `claim-issuance:${o.id}`,
        amountTokens: Number(o.granted), actor: 'system',
      });
      inserted++;
    }
    // Refunds → reduce intents.
    const refunds = await db.many(
      `SELECT r.id, r.user_id, r.tokens_removed FROM public.order_refunds r
       WHERE r.tokens_removed > 0
         AND NOT EXISTS (SELECT 1 FROM public.key_issuance_intents i WHERE i.idempotency_key = 'refund:' || r.id::text)`);
    for (const r of refunds) {
      if (!(await effectivePerUser(db, cfg, r.user_id))) continue;
      const keyRow = await getKeyRow(db, r.user_id);
      if (!keyRow?.encrypted_key) continue;
      await insertIntent(db, {
        userId: r.user_id, kind: 'reduce', source: 'refund', refundId: Number(r.id),
        idempotencyKey: `refund:${r.id}`, amountTokens: Number(r.tokens_removed), actor: 'system',
      });
      inserted++;
    }
    // Manual charges → topup/reduce (only charges made after the user's key
    // exists; earlier ones are part of the converted/purchased totals).
    const charges = await db.many(
      `SELECT l.id, l.user_id, l.delta_tokens FROM public.ledger l
       WHERE l.kind = 'adjust'
         AND NOT EXISTS (SELECT 1 FROM public.key_issuance_intents i WHERE i.idempotency_key = 'adjust:' || l.id::text)
         AND EXISTS (SELECT 1 FROM public.user_provider_keys k WHERE k.user_id = l.user_id AND k.created_at <= l.created_at)`);
    for (const c of charges) {
      if (!(await effectivePerUser(db, cfg, c.user_id))) continue;
      const delta = Number(c.delta_tokens);
      if (!delta) continue;
      await insertIntent(db, {
        userId: c.user_id, kind: delta > 0 ? 'topup' : 'reduce',
        source: 'admin_charge', ledgerIdempotencyKey: `adjust:${c.id}`,
        idempotencyKey: `adjust:${c.id}`, amountTokens: Math.abs(delta), actor: 'system',
      });
      inserted++;
    }
    // Conversions stamped by the RPC but missing their intent.
    const convs = await db.many(
      `SELECT user_id, converted_tokens FROM public.user_provider_keys
       WHERE converted_at IS NOT NULL AND converted_tokens > 0
         AND NOT EXISTS (SELECT 1 FROM public.key_issuance_intents i
                         WHERE i.idempotency_key = 'conversion:' || user_provider_keys.user_id::text)`);
    for (const c of convs) {
      if (!(await effectivePerUser(db, cfg, c.user_id))) continue;
      await insertIntent(db, {
        userId: c.user_id, kind: 'convert', source: 'conversion',
        idempotencyKey: `conversion:${c.user_id}`,
        ledgerIdempotencyKey: `convert:v1:${c.user_id}`,
        amountTokens: Number(c.converted_tokens), actor: 'system',
      });
      inserted++;
    }
    return inserted;
  }

  async function drainOnce({ sweep = false } = {}) {
    if (!encryptionReady(cfg) && (cfg.cvcPrimaryApiKey || cfg.cvcBaseUrl)) {
      // §10 row 13: fail closed for issuance when the encryption key is bad,
      // but only when Phase 2 is configured at all.
      if (await anyPerUser()) {
        log.error('cvc_key_encryption_key_invalid', {});
        return { processed: 0, blocked: 'encryption_key_invalid' };
      }
    }
    if (await breakerOpen(db, cfg)) return { processed: 0, blocked: 'breaker_open' };
    await reclaimStale();
    if (sweep) await sweepBackfill();
    let processed = 0;
    for (let guard = 0; guard < 200; guard++) {
      const claimed = await claimNext();
      if (!claimed) break;
      const intent = await coalesce(claimed);
      await execute(intent);
      processed++;
      if (await breakerOpen(db, cfg)) break;
    }
    return { processed };
  }

  async function anyPerUser() {
    const { getRouting } = await import('./routing.js');
    const r = await getRouting(db, cfg);
    return r.mode === 'per_user' || r.allowlist.length > 0;
  }

  return {
    client, drainOnce, sweepBackfill, reclaimStale,
    reconcile: (opts) => reconcileSweep(db, cfg, client, opts),
    start({ drainMs = 15_000, sweepEveryMs = 60_000, reconcileEveryMs = 15 * 60_000 } = {}) {
      let sweeping = null;
      const tick = () => { drainOnce().catch((e) => log.warn('reseller_drain_failed', { error: e.message })); };
      const timers = [
        setInterval(tick, cfg.resellerDrainMs ?? drainMs).unref(),
        setInterval(() => {
          if (!sweeping) sweeping = drainOnce({ sweep: true })
            .catch((e) => log.warn('reseller_sweep_failed', { error: e.message }))
            .finally(() => { sweeping = null; });
        }, sweepEveryMs).unref(),
        setInterval(() => { reconcileSweep(db, cfg, client).catch((e) => log.warn('reconcile_failed', { error: e.message })); },
          reconcileEveryMs).unref(),
      ];
      tick();
      return { stop: () => timers.forEach(clearInterval) };
    },
  };
}
