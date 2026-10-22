import { requireRateLimit } from './ratelimit.js';
import { getMultiplier } from './settings.js';
import { reserveHold, commitHold, releaseHold, spendableTokens } from './ledger.js';
import { HttpError, badRequest, paymentRequired } from './util.js';
import { readBody, sendJson } from './http.js';

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

export async function handleChatCompletions(db, cfg, req, res, user) {
  const raw = await readBody(req, 4_000_000);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw badRequest('invalid_json', 'Body must be JSON.'); }
  if (!body || typeof body !== 'object' || !body.model) throw badRequest('model_required', 'model is required.');
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
    const multiplier = await getMultiplier(db, cfg, body.model);
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
