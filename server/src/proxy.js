import { requireRateLimit } from './ratelimit.js';
import { getMultiplier, getModelEntry } from './settings.js';
import { reserveHold, commitHold, releaseHold, spendableTokens } from './ledger.js';
import { HttpError, badRequest, paymentRequired, forbidden } from './util.js';
import { readBody, sendJson } from './http.js';
import { routedPerUser } from './reseller/routing.js';
import { decryptDelegatedKey } from './reseller/crypto.js';
import { raiseAttentionFlag } from './reseller/reconcile.js';
import { log } from './log.js';

/**
 * Metering proxy — POST /v1/chat/completions (OpenAI-compatible).
 *
 * Golden rule (security review): the upstream key lives ONLY here, server-side.
 * Flow: authenticate → rate/concurrency limits → reserve (hold) the estimated
 * max cost inside the reserve_hold RPC (per-user row lock → race-safe) →
 * forward to upstream → read `usage` from the upstream response (never trust
 * client numbers) → commit actual, release rest. An Idempotency-Key replays
 * the stored response instead of double-charging.
 */

const inFlight = new Map(); // userId -> concurrent upstream calls

function estimatePromptTokens(body) {
  let chars = 0;
  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) chars += (p.text ?? '').length;
  }
  return Math.ceil(chars / 4);
}

export async function handleChatCompletions(db, cfg, req, res, user, opts = {}) {
  const raw = await readBody(req, 4_000_000);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw badRequest('invalid_json', 'Body must be JSON.'); }
  if (!body || typeof body !== 'object' || !body.model) throw badRequest('model_required', 'model is required.');

  // Phase 2 thin relay (§6): per-user users bypass Hold/Commit entirely —
  // the provider enforces their own key's allowance.
  const routing = await routedPerUser(db, cfg, user.id);
  if (routing.perUser || opts.delegatedKey) {
    return handlePerUser(db, cfg, req, res, user, body, routing.keyRow, opts);
  }
  if (!cfg.upstreamBaseUrl || !cfg.upstreamApiKey)
    throw new HttpError(503, 'upstream_not_configured', 'Subscription upstream is not configured on this server.');

  const userId = user.id;
  const idemKey = req.headers['idempotency-key'] || null;

  // Idempotent replay: an already-committed hold returns its stored response, free.
  if (idemKey) {
    const prev = await db.one(
      'SELECT * FROM public.holds WHERE user_id = $1 AND idempotency_key = $2', [userId, idemKey]);
    if (prev?.status === 'committed' && prev.response_json) {
      return sendJson(res, 200, prev.response_json);
    }
    if (prev?.status === 'reserved') throw new HttpError(409, 'request_in_flight', 'A request with this Idempotency-Key is still in flight.');
  }

  await requireRateLimit(db, `chat:min:${userId}`, cfg.chatRatePerMin, 60_000, 'chat_rate_limited');
  const concurrent = inFlight.get(userId) ?? 0;
  if (concurrent >= cfg.chatMaxConcurrent) throw new HttpError(429, 'too_many_concurrent', 'Too many concurrent requests.');
  inFlight.set(userId, concurrent + 1);

  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    // Admin per-model enable/disable (PRD §6.7): a disabled model is refused
    // before any hold is reserved — no charge, no upstream call.
    const entry = await getModelEntry(db, cfg, body.model);
    if (entry && entry.enabled === false) {
      throw new HttpError(403, 'model_disabled', `Model ${body.model} is disabled by the admin.`);
    }
    // Fast mode: header `x-ronin-fast: 1|true` or body flag `ronin_fast: true`.
    // The body flag is a Ronin control field — it is stripped before the
    // request is forwarded upstream and only affects the multiplier.
    const fast = ['1', 'true'].includes(String(req.headers['x-ronin-fast'] ?? '').toLowerCase())
      || body.ronin_fast === true;
    delete body.ronin_fast;
    const multiplier = await getMultiplier(db, cfg, body.model, { fast });
    const maxCompletion = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
    const reservedTokens = Math.max(1, Math.ceil((estimatePromptTokens(body) + maxCompletion) * multiplier));

    const reserved = await reserveHold(db, {
      userId, requestId, idempotencyKey: idemKey, model: body.model, multiplier,
      reservedTokens, actor: `user:${userId}`,
    });
    if (!reserved) {
      const spendable = await spendableTokens(db, userId);
      throw paymentRequired('insufficient_credit', `Insufficient token credit. Spendable: ${spendable}, needed (max estimate): ${reservedTokens}.`);
    }
    const hold = reserved.hold;
    if (reserved.replayed) {
      // Same key arrived while/after the original ran (race-safe double check).
      if (hold.status === 'committed') {
        if (hold.response_json) return sendJson(res, 200, hold.response_json);
        throw new HttpError(409, 'duplicate_request', 'This Idempotency-Key already completed (streamed responses are not replayable).');
      }
      throw new HttpError(409, 'request_in_flight', 'A request with this Idempotency-Key is still in flight.');
    }

    let upstream;
    try {
      upstream = await fetch(`${cfg.upstreamBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.upstreamApiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      await releaseHold(db, { holdId: hold.id, reason: 'upstream_unreachable' });
      throw new HttpError(502, 'upstream_unreachable', 'Upstream gateway unreachable.');
    }

    if (body.stream === true) return await proxyStream(db, cfg, upstream, res, hold, multiplier, body);
    return await proxyBuffered(db, upstream, res, hold, multiplier);
  } finally {
    inFlight.set(userId, Math.max(0, (inFlight.get(userId) ?? 1) - 1));
  }
}

function actualCost(usage, multiplier, fallbackText = '') {
  if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
    return Math.ceil(((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) * multiplier);
  }
  // No usage from upstream: fall back to a text-length estimate (documented in README).
  return Math.max(1, Math.ceil((fallbackText.length / 4) * multiplier));
}

async function proxyBuffered(db, upstream, res, hold, multiplier) {
  const text = await upstream.text();
  if (!upstream.ok) {
    await releaseHold(db, { holdId: hold.id, reason: `upstream_${upstream.status}` });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    return res.end(text);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  const contentText = json?.choices?.map((c) => c.message?.content ?? '').join('') ?? text;
  await commitHold(db, { holdId: hold.id, actualTokens: actualCost(json?.usage, multiplier, contentText), responseJson: json });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(text);
}

async function proxyStream(db, cfg, upstream, res, hold, multiplier, body) {
  if (!upstream.ok || !upstream.body) {
    const text = upstream.body ? await upstream.text() : '';
    await releaseHold(db, { holdId: hold.id, reason: `upstream_${upstream.status}` });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    return res.end(text);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive',
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', contentText = '', usage = null, clientGone = false;
  res.on('close', () => { clientGone = true; });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!clientGone) res.write(chunk);
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          if (evt.usage) usage = evt.usage;
          for (const c of evt.choices ?? []) contentText += c.delta?.content ?? '';
        } catch { /* partial line */ }
      }
    }
  } catch {
    // Upstream stream broke mid-flight: settle with what we observed.
  } finally {
    try { res.end(); } catch { /* already closed */ }
    await commitHold(db, {
      holdId: hold.id,
      actualTokens: actualCost(usage, multiplier, contentText),
      responseJson: null, // streams are not replayable; idempotent replay applies to buffered calls
    });
  }
}

// ── Phase 2 thin relay (§6) ─────────────────────────────────────────────────
// No Hold/Commit, no multipliers, no shared key. Dual-auth converges in
// app.js: opts.delegatedKey = path B (host presented its delegated key),
// otherwise path A (session Bearer) decrypts server-side here.
async function handlePerUser(db, cfg, req, res, user, body, keyRow, opts) {
  const userId = user.id;
  if (!cfg.cvcBaseUrl) throw new HttpError(503, 'upstream_not_configured', 'Provider is not configured on this server.');
  if (!keyRow) {
    const { getKeyRow } = await import('./reseller/routing.js');
    keyRow = await getKeyRow(db, userId);
  }
  if (!keyRow?.encrypted_key && !opts.delegatedKey) {
    throw new HttpError(503, 'provider_key_not_ready', 'Your provider key is still being set up.');
  }
  if (keyRow?.status === 'frozen' || !user.is_active) {
    throw forbidden('account_suspended', 'Account suspended.');
  }
  if (keyRow?.status === 'deleted') {
    throw new HttpError(503, 'provider_key_not_ready', 'Your provider key is not ready.');
  }
  if (keyRow?.status === 'needs_attention') {
    log.warn('proxy_key_needs_attention_proceeding', { userId });
  }

  await requireRateLimit(db, `chat:min:${userId}`, cfg.chatRatePerMin, 60_000, 'chat_rate_limited');
  const concurrent = inFlight.get(userId) ?? 0;
  if (concurrent >= cfg.chatMaxConcurrent) throw new HttpError(429, 'too_many_concurrent', 'Too many concurrent requests.');
  inFlight.set(userId, concurrent + 1);
  try {
    const entry = await getModelEntry(db, cfg, body.model);
    if (entry && entry.enabled === false) {
      throw new HttpError(403, 'model_disabled', `Model ${body.model} is disabled by the admin.`);
    }
    let delegatedKey = opts.delegatedKey ?? null;
    if (!delegatedKey) {
      try {
        delegatedKey = decryptDelegatedKey(cfg, keyRow.encrypted_key, { userId, keyRowId: keyRow.id });
      } catch {
        await raiseAttentionFlag(db, userId, `decrypt failure for key row ${keyRow.id}`).catch(() => {});
        throw new HttpError(503, 'provider_key_not_ready', 'Your provider key needs attention.');
      }
    }
    // Fast (§6.2 step 3): x-ronin-fast header or ronin_fast body flag →
    // service_tier 'priority'; Ronin control fields never leak upstream.
    const fast = ['1', 'true'].includes(String(req.headers['x-ronin-fast'] ?? '').toLowerCase())
      || body.ronin_fast === true;
    delete body.ronin_fast;
    if (fast) body.service_tier = 'priority';

    // Throttled last-used touch (≤1/min/user) — drives activity-tiered polling.
    const lastUsed = keyRow.last_used_at ? new Date(keyRow.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > 60_000) {
      void db.query('UPDATE public.user_provider_keys SET last_used_at = now() WHERE id = $1', [keyRow.id]).catch(() => {});
    }

    let upstream;
    try {
      upstream = await fetch(`${cfg.cvcBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${delegatedKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new HttpError(502, 'upstream_unreachable', 'Upstream gateway unreachable.');
    }

    // Error mapping (§6.4)
    if (upstream.status === 402) {
      await upstream.text().catch(() => '');
      throw paymentRequired('insufficient_credit', 'Insufficient token credit.');
    }
    if (upstream.status === 401) {
      await upstream.text().catch(() => '');
      await raiseAttentionFlag(db, userId, 'provider rejected the delegated key (401)').catch(() => {});
      throw new HttpError(502, 'provider_key_invalid', 'Provider rejected the key.');
    }
    if (upstream.status === 403) {
      await upstream.text().catch(() => '');
      log.error('provider_forbidden_runtime', { userId });
      throw new HttpError(502, 'provider_forbidden', 'Provider refused the request.');
    }

    const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/json' };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) headers['Retry-After'] = retryAfter;

    if (body.stream === true && upstream.body) {
      res.writeHead(upstream.status, {
        ...headers, 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch { /* stream broke — nothing to settle in per-user mode */ }
      finally { try { res.end(); } catch { /* closed */ } }
      return;
    }
    const text = await upstream.text();
    res.writeHead(upstream.status, headers);
    return res.end(text);
  } finally {
    inFlight.set(userId, Math.max(0, (inFlight.get(userId) ?? 1) - 1));
  }
}

