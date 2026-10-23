import { fingerprintOf } from './crypto.js';
import { log } from '../log.js';

/**
 * CheapVibeCode reseller client — design §3.6. The ONLY module that talks to
 * the provider control plane. Contract rules honoured here:
 *  - primary key ONLY from env (cfg.cvcPrimaryApiKey); never logged/returned;
 *  - NO internal retries for mutations — retry policy lives in the worker,
 *    where outcomes are classified (confirmed / safe_retry / terminal /
 *    ambiguous). Reads may retry twice on 429/503.
 *  - branching is on HTTP status + error.code, never message text;
 *  - primary-key guard: an edit target whose fingerprint matches the primary
 *    key throws BEFORE dispatch; targets must also match the fingerprint of
 *    a user_provider_keys row when one is supplied.
 *  - keys are opaque: never parsed, never branched on by prefix.
 */

export class ResellerError extends Error {
  constructor(classification, { status = null, code = null, retryAfterMs = null } = {}) {
    super(`reseller_${classification}${code ? `:${code}` : ''}`);
    this.classification = classification; // confirmed|safe_retry|terminal|auth_terminal|ambiguous|not_found
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createResellerClient(cfg, fetchImpl = null) {
  const doFetch = fetchImpl ?? cfg.cvcFetch ?? globalThis.fetch;
  const MUTATION_TIMEOUT_MS = cfg.cvcMutationTimeoutMs ?? 10_000;
  const READ_TIMEOUT_MS = cfg.cvcReadTimeoutMs ?? 8_000;
  const base = () => String(cfg.cvcBaseUrl || '').replace(/\/$/, '');
  const primary = () => cfg.cvcPrimaryApiKey || '';

  async function raw(path, { method = 'GET', authKey, body = null, timeoutMs }) {
    if (!base()) throw new ResellerError('terminal', { code: 'cvc_not_configured' });
    if (!authKey) throw new ResellerError('auth_terminal', { code: 'cvc_credential_missing' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(`${base()}${path}`, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authKey}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // Connection refused / DNS failure happen BEFORE any bytes are sent —
      // provably not dispatched, hence a safe retry (§3.4). Timeout / reset /
      // lost response after dispatch: outcome unknowable → ambiguous.
      const causeCode = e?.cause?.code ?? e?.code ?? null;
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode)) {
        throw new ResellerError('safe_retry', { code: `connect_${String(causeCode).toLowerCase()}` });
      }
      throw new ResellerError('ambiguous', { code: e?.name === 'AbortError' ? 'timeout' : 'network' });
    } finally { clearTimeout(timer); }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { res, json };
  }

  function classifyHttp(status, code, retryAfter, { mutation }) {
    if (status === 429) {
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      return new ResellerError('safe_retry', { status, code, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null });
    }
    if (status === 401 || status === 403) return new ResellerError('auth_terminal', { status, code });
    if (status === 404) return new ResellerError('not_found', { status, code });
    if (status === 400 || status === 409) return new ResellerError('terminal', { status, code });
    if (status >= 500) return new ResellerError(mutation ? 'ambiguous' : 'safe_retry', { status, code });
    return new ResellerError('terminal', { status, code });
  }

  async function call(path, { method = 'GET', authKey, body = null, mutation = false }) {
    const attempts = mutation ? 1 : 3;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const { res, json } = await raw(path, {
          method, authKey, body, timeoutMs: mutation ? MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS,
        });
        if (res.status >= 200 && res.status < 300) return { status: res.status, data: json };
        const err = classifyHttp(res.status, json?.error?.code ?? null, res.headers.get('retry-after'), { mutation });
        if (!mutation && err.classification === 'safe_retry' && i < attempts - 1) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs ?? 100 * (i + 1), 1000)));
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof ResellerError && e.classification !== 'ambiguous') throw e;
        if (!mutation && i < attempts - 1) { lastErr = e; continue; }
        throw e;
      }
    }
    throw lastErr ?? new ResellerError('ambiguous', {});
  }

  /** Defence in depth (§3.6): refuse to target the primary key, pre-dispatch. */
  function guardTarget(targetKey, expectedFingerprint = null) {
    const fp = fingerprintOf(targetKey);
    if (primary() && fp === fingerprintOf(primary())) {
      const err = new ResellerError('terminal', { code: 'primary_guard' });
      err.primaryGuard = true;
      throw err;
    }
    if (expectedFingerprint && fp !== expectedFingerprint) {
      throw new ResellerError('terminal', { code: 'fingerprint_mismatch' });
    }
    return fp;
  }

  return {
    guardTarget,
    /** POST /v1/keys (primary). Returns { key, meta } — plaintext held by caller only. */
    async createKey({ name, tokenLimit }) {
      const out = await call('/v1/keys', {
        method: 'POST', authKey: primary(), mutation: true,
        body: { name, token_limit: tokenLimit }, // allowed_models omitted = full catalog (§3.2/A5)
      });
      if (!out.data?.key || !out.data?.meta) {
        throw new ResellerError('ambiguous', { status: out.status, code: 'create_response_unparseable' });
      }
      return { status: out.status, key: out.data.key, meta: out.data.meta };
    },
    /** POST /v1/keys/edit (primary). Target addressed by its plaintext + row fingerprint. */
    async editKey({ targetKey, expectedFingerprint = null, fields }) {
      guardTarget(targetKey, expectedFingerprint);
      const out = await call('/v1/keys/edit', {
        method: 'POST', authKey: primary(), mutation: true,
        body: { key: targetKey, ...fields },
      });
      return { status: out.status, data: out.data };
    },
    /** GET /v1/balance with a delegated (or primary) key. Upper bound only (§8.2). */
    async getBalance(anyKey) {
      const out = await call('/v1/balance', { authKey: anyKey });
      const bal = out.data?.balance ?? out.data?.tokens ?? out.data?.available ?? null;
      if (bal === null || !Number.isFinite(Number(bal))) {
        // Some deployments return { balance_tokens } — accept numeric fields only.
        const numField = Object.values(out.data ?? {}).find((v) => typeof v === 'number');
        if (numField === undefined) throw new ResellerError('safe_retry', { status: out.status, code: 'balance_unparseable' });
        return Number(numField);
      }
      return Number(bal);
    },
    /** GET /v1/keys/logs with the delegated key itself: newest 30 + total. */
    async getLogs(delegatedKey) {
      const out = await call('/v1/keys/logs', { authKey: delegatedKey });
      return {
        logs: Array.isArray(out.data?.logs) ? out.data.logs : [],
        total: Number(out.data?.total ?? 0),
      };
    },
    /** GET /v1/chat/completions is NOT here — the thin relay forwards it (§6). */
    _logGuardTrip() { log.error('provider_primary_guard_tripped', {}); },
  };
}
