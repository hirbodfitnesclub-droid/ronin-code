import { sendJson, readJson } from '../http.js';
import { audit } from '../db.js';
import { badRequest, notFound, ms, num } from '../util.js';
import { getKeyRow, getRouting, setRouting, setBreaker } from '../reseller/routing.js';
import { insertIntent, publicIntent, ensureMirrorIntent } from '../reseller/intents.js';
import { createWorker } from '../reseller/worker.js';
import { pollKey } from '../reseller/reconcile.js';
import { createResellerClient } from '../reseller/client.js';
import { decryptDelegatedKey } from '../reseller/crypto.js';
import { getProviderBalance } from '../reseller/balance.js';
import { adjustCredit } from '../ledger.js';
import * as auth from '../auth.js';

/**
 * Admin provider-key surface — design §3.5, §4.4, §7.4, §11.
 * Reads: cap finance_view / finance_user. Freeze/unfreeze: risk_manage.
 * Resolutions, routing flag, reconcile, rollback, closure: OWNER only.
 */

export function publicProviderKey(k) {
  if (!k) return null;
  return {
    id: Number(k.id), userId: k.user_id, status: k.status,
    keyLast4: k.key_last4, providerKeyName: k.provider_key_name,
    tokenLimitIssued: Number(k.token_limit_issued ?? 0),
    tokensUsedObserved: Number(k.tokens_used_observed ?? 0),
    balanceObserved: k.balance_observed === null ? null : Number(k.balance_observed),
    balanceObservedAt: ms(k.balance_observed_at),
    balanceAgeMs: k.balance_observed_at ? Date.now() - new Date(k.balance_observed_at).getTime() : null,
    allowedModels: k.allowed_models ?? null,
    convertedAt: ms(k.converted_at), convertedTokens: k.converted_tokens === null ? null : Number(k.converted_tokens),
    logsGapRows: Number(k.logs_gap_rows ?? 0),
    lastReconciledAt: ms(k.last_reconciled_at), lastUsedAt: ms(k.last_used_at),
    createdAt: ms(k.created_at), updatedAt: ms(k.updated_at),
  };
}

export function registerProviderRoutes(router, { db, cfg, guardCap, guardOwner }) {
  const worker = () => createWorker(db, cfg);

  router.get('/admin-api/provider/intents', async (req, res, { query }) => {
    await guardCap('finance_view')(req);
    const state = query.get('state');
    const rows = state
      ? await db.many('SELECT * FROM public.key_issuance_intents WHERE state = $1 ORDER BY id DESC LIMIT 200', [state])
      : await db.many('SELECT * FROM public.key_issuance_intents ORDER BY id DESC LIMIT 200');
    sendJson(res, 200, { intents: rows.map(publicIntent) });
  });

  router.post('/admin-api/provider/intents/:id/resolve', async (req, res, { params }) => {
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    const decision = String(body.decision ?? '');
    if (!['mark_applied', 'retry_once', 'create_replacement', 'abandon'].includes(decision)) {
      throw badRequest('invalid_decision', 'decision must be mark_applied|retry_once|create_replacement|abandon.');
    }
    const intent = await db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [Number(params.id)]);
    if (!intent) throw notFound('intent_not_found', 'Intent not found.');
    if (intent.state !== 'needs_attention' && decision !== 'retry_once') {
      throw badRequest('intent_not_attention', 'Only needs_attention intents can be resolved this way.');
    }
    const keyRow = await getKeyRow(db, intent.user_id);
    let replacement = null;

    if (decision === 'mark_applied') {
      if (intent.kind === 'create' || intent.kind === 'convert' && !keyRow?.encrypted_key) {
        throw badRequest('cannot_mark_create_applied', 'A create cannot be marked applied: no plaintext was captured. Use create_replacement.');
      }
      if ((intent.kind === 'topup' || intent.kind === 'convert') && keyRow) {
        await db.query('UPDATE public.user_provider_keys SET token_limit_issued = token_limit_issued + $2, updated_at = now() WHERE id = $1',
          [keyRow.id, Number(intent.amount_tokens ?? 0)]);
      } else if (intent.kind === 'reduce' && keyRow && intent.target_token_limit !== null) {
        await db.query('UPDATE public.user_provider_keys SET token_limit_issued = $2, updated_at = now() WHERE id = $1',
          [keyRow.id, Number(intent.target_token_limit)]);
      } else if (intent.kind === 'freeze' && keyRow) {
        await db.query("UPDATE public.user_provider_keys SET status = 'frozen', updated_at = now() WHERE id = $1", [keyRow.id]);
      } else if (intent.kind === 'unfreeze' && keyRow) {
        await db.query("UPDATE public.user_provider_keys SET status = 'active', updated_at = now() WHERE id = $1", [keyRow.id]);
      } else if (intent.kind === 'delete' && keyRow) {
        await db.query("UPDATE public.user_provider_keys SET status = 'deleted', encrypted_key = NULL, key_fingerprint = NULL, key_last4 = NULL, updated_at = now() WHERE id = $1", [keyRow.id]);
      }
      await db.query("UPDATE public.key_issuance_intents SET state = 'confirmed', completed_at = now(), updated_at = now() WHERE id = $1", [intent.id]);
    } else if (decision === 'abandon') {
      await db.query("UPDATE public.key_issuance_intents SET state = 'superseded', completed_at = now(), updated_at = now() WHERE id = $1", [intent.id]);
    } else if (decision === 'create_replacement') {
      if (!['create', 'convert'].includes(intent.kind)) {
        throw badRequest('replacement_create_only', 'Replacement applies to create/convert intents only.');
      }
      await db.query("UPDATE public.key_issuance_intents SET state = 'superseded', completed_at = now(), updated_at = now() WHERE id = $1", [intent.id]);
      if (keyRow?.status === 'needs_attention') {
        await db.query("UPDATE public.user_provider_keys SET status = 'pending_create', updated_at = now() WHERE id = $1", [keyRow.id]);
      }
      replacement = await insertIntent(db, {
        userId: intent.user_id, kind: 'create', source: intent.source === 'conversion' ? 'conversion' : 'claim',
        idempotencyKey: `replacement:${intent.id}:${Date.now()}`,
        amountTokens: Number(intent.amount_tokens ?? 0), actor: `admin:${session.phone}`,
        orderId: intent.order_id ? Number(intent.order_id) : null,
      });
    } else if (decision === 'retry_once') {
      await db.query(
        "UPDATE public.key_issuance_intents SET state = 'pending', next_attempt_at = now(), updated_at = now() WHERE id = $1",
        [intent.id]);
      // Human-confirmed single re-dispatch (double-add risk is now a named
      // human decision, §3.5). Drain runs the queue; this intent is oldest
      // for its user in practice.
      void worker().drainOnce().catch(() => {});
    }
    await audit(db, session.phone, 'provider_intent_resolved', `user:${intent.user_id}`,
      { intentId: Number(intent.id), decision, replacementIntentId: replacement ? Number(replacement.id) : null });
    const fresh = await db.one('SELECT * FROM public.key_issuance_intents WHERE id = $1', [intent.id]);
    sendJson(res, 200, {
      intent: publicIntent(fresh),
      ...(replacement ? { replacement: publicIntent(replacement) } : {}),
    });
  });

  router.get('/admin-api/users/:id/provider-key', async (req, res, { params }) => {
    await guardCap('finance_user')(req);
    const user = await db.one('SELECT id FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const keyRow = await getKeyRow(db, user.id);
    const intents = await db.many(
      'SELECT * FROM public.key_issuance_intents WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [user.id]);
    const flags = await db.many(
      "SELECT * FROM public.risk_flags WHERE user_id = $1 AND kind IN ('provider_drift','provider_key_attention') AND status = 'open' ORDER BY id DESC",
      [user.id]);
    sendJson(res, 200, {
      providerKey: publicProviderKey(keyRow),
      intents: intents.map(publicIntent),
      needsAttention: intents.filter((i) => i.state === 'needs_attention').map(publicIntent),
      openProviderFlags: flags.map((f) => ({
        id: Number(f.id), kind: f.kind, note: f.note, createdBy: f.created_by, createdAt: ms(f.created_at),
      })),
    });
  });

  router.post('/admin-api/users/:id/provider-key/refresh', async (req, res, { params }) => {
    await guardCap('finance_user', { mutate: true })(req);
    const user = await db.one('SELECT id FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const keyRow = await getKeyRow(db, user.id);
    if (!keyRow?.encrypted_key) throw notFound('provider_key_not_found', 'User has no provider key yet.');
    const client = createResellerClient(cfg);
    const result = await pollKey(db, cfg, client, keyRow);
    const plain = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId: user.id, keyRowId: keyRow.id });
    const { logs, total } = await client.getLogs(plain);
    const fresh = await getKeyRow(db, user.id);
    sendJson(res, 200, {
      providerKey: publicProviderKey(fresh),
      poll: result,
      recentLogs: logs.map((l) => ({
        model: l.model, costTokens: Number(l.cost_tokens ?? 0), status: l.status, createdAt: l.created_at,
      })),
      totalRequests: total,
    });
  });

  const keyAction = (kind, source) => async (req, res, { params }) => {
    const session = await guardCap('risk_manage', { mutate: true })(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const keyRow = await getKeyRow(db, user.id);
    if (!keyRow?.encrypted_key) throw notFound('provider_key_not_found', 'User has no provider key yet.');
    const live = await db.one(
      "SELECT id FROM public.key_issuance_intents WHERE user_id = $1 AND kind = $2 AND state IN ('pending','in_flight') LIMIT 1",
      [user.id, kind]);
    if (live) return sendJson(res, 200, { ok: true, alreadyInFlight: true, intentId: Number(live.id) });
    const intent = await insertIntent(db, {
      userId: user.id, kind, source,
      idempotencyKey: `${kind}:${user.id}:${Date.now()}`,
      actor: `admin:${session.phone}`,
    });
    await audit(db, session.phone, kind === 'freeze' ? 'provider_key_freeze_requested' : 'provider_key_unfreeze_requested',
      `user:${user.id}`, { intentId: intent ? Number(intent.id) : null });
    sendJson(res, 200, { ok: true, intent: publicIntent(intent) });
  };
  router.post('/admin-api/users/:id/provider-key/freeze', keyAction('freeze', 'suspend'));
  router.post('/admin-api/users/:id/provider-key/unfreeze', keyAction('unfreeze', 'reactivate'));

  // Account closure (§4.4): owner-only, typed phone confirmation, mandatory note.
  router.post('/admin-api/users/:id/close', async (req, res, { params }) => {
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [params.id]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    if (String(body.confirmPhone ?? '') !== user.phone) {
      throw badRequest('confirm_phone_mismatch', 'confirmPhone must exactly match the user phone.');
    }
    if (!body.note || String(body.note).trim().length < 3) throw badRequest('note_required', 'A closure note is required.');
    await db.query('UPDATE public.users SET is_active = false WHERE id = $1', [user.id]);
    await auth.logoutAll(db, user.id);
    await audit(db, session.phone, 'user_closed', `user:${user.id}`, { note: String(body.note) });
    const intent = await ensureMirrorIntent(db, cfg, {
      userId: user.id, kind: 'delete', source: 'close',
      idempotencyKey: `close:${user.id}`, actor: `admin:${session.phone}`,
    }) ?? await insertIntent(db, {
      // Closure deletes the key even if the routing flag is off for the user.
      userId: user.id, kind: 'delete', source: 'close',
      idempotencyKey: `close:${user.id}`, actor: `admin:${session.phone}`,
    }).catch(() => null);
    sendJson(res, 200, { ok: true, intent: publicIntent(intent) });
  });

  // Routing flag (§11)
  router.get('/admin-api/settings/subscription-routing', async (req, res) => {
    await guardCap('finance_view')(req);
    sendJson(res, 200, { routing: await getRouting(db, cfg) });
  });
  router.put('/admin-api/settings/subscription-routing', async (req, res) => {
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    const routing = await setRouting(db, body);
    if (body.clearBreaker) await setBreaker(db, false, {});
    await audit(db, session.phone, 'subscription_routing_updated', 'settings:subscription_routing', { mode: routing.mode, allowlist: routing.allowlist.length });
    sendJson(res, 200, { ok: true, routing });
  });

  router.post('/admin-api/provider/reconcile', async (req, res) => {
    const session = await guardOwner({ mutate: true })(req);
    const result = await worker().reconcile();
    await audit(db, session.phone, 'provider_reconcile_run', 'provider', result);
    sendJson(res, 200, { ok: true, ...result });
  });

  // Rollback one user to shared (§11.3): final poll → ledger adjust debit of
  // observed usage (capped at balance) → freeze intent. Partial data is an
  // owner decision: pass debitTokens explicitly to override the observed U.
  router.post('/admin-api/provider/rollback-user', async (req, res) => {
    const session = await guardOwner({ mutate: true })(req);
    const body = await readJson(req);
    const user = await db.one('SELECT * FROM public.users WHERE id = $1', [String(body.userId ?? '')]);
    if (!user) throw notFound('user_not_found', 'User not found.');
    const keyRow = await getKeyRow(db, user.id);
    if (keyRow?.encrypted_key) {
      await pollKey(db, cfg, createResellerClient(cfg), keyRow).catch(() => {});
    }
    const fresh = await getKeyRow(db, user.id);
    const observed = Number(fresh?.tokens_used_observed ?? 0);
    const partial = Number(fresh?.logs_gap_rows ?? 0) > 0;
    if (partial && body.debitTokens === undefined) {
      throw badRequest('partial_data_owner_decision', 'Usage data is partial (log gaps); pass debitTokens explicitly.');
    }
    const balRow = await db.one('SELECT public.ledger_balance($1) AS b', [user.id]);
    const debit = Math.min(Number(body.debitTokens ?? observed), Number(balRow.b));
    let ledgerId = null;
    if (debit > 0) {
      await adjustCredit(db, { userId: user.id, tokens: -debit, actor: `admin:${session.phone}`, note: 'phase2-rollback' });
      const led = await db.one("SELECT id FROM public.ledger WHERE user_id = $1 AND kind = 'adjust' ORDER BY id DESC LIMIT 1", [user.id]);
      ledgerId = led ? Number(led.id) : null;
    }
    const freeze = keyRow?.encrypted_key ? await insertIntent(db, {
      userId: user.id, kind: 'freeze', source: 'suspend',
      idempotencyKey: `rollback-freeze:${user.id}:${Date.now()}`, actor: `admin:${session.phone}`,
    }) : null;
    await audit(db, session.phone, 'provider_rollback_user', `user:${user.id}`,
      { observedUsage: observed, debitTokens: debit, partial, ledgerId });
    sendJson(res, 200, { ok: true, observedUsage: observed, debitTokens: debit, partial, freezeIntent: publicIntent(freeze) });
  });
}
