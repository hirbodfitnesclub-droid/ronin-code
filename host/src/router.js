// Ronin Code — local host service.
// Provider routing brain: multi-key rotation with cooldowns, the
// failover chain, RTK-style tool-output compression, and the
// connection test used by Settings.

import { config, providerById, keyList, currentModel } from "./config.js";
import { loadUsage, saveUsage, keyIdOf } from "./usage.js";
import { CATALOG } from "./catalog.js";

export async function testProviderKey(providerId, apiKey, baseUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    let url, headers = {};
    if (providerId === "anthropic") {
      url = "https://api.anthropic.com/v1/models";
      headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    } else if (providerId === "openai") {
      url = "https://api.openai.com/v1/models";
      headers = { Authorization: `Bearer ${apiKey}` };
    } else if (providerId === "google") {
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    } else if (providerId === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
      headers = { Authorization: `Bearer ${apiKey}` };
    } else if (providerId === "custom") {
      const base = typeof baseUrl === "string" && baseUrl ? baseUrl.replace(/\/+$/, "") : null;
      if (!base) return { ok: false, message: "Set the endpoint URL for the custom provider first." };
      url = `${base}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
    } else {
      return { ok: false, message: `Unknown provider: ${providerId}` };
    }
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (resp.ok) return { ok: true, message: "Connection succeeded — the API key works." };
    if (resp.status === 401 || resp.status === 403)
      return { ok: false, message: "The provider rejected this API key. Check the key and try again." };
    return { ok: false, message: `The provider responded with status ${resp.status}. Please try again.` };
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, message: "The connection test timed out after 10 seconds." };
    return { ok: false, message: "Could not reach the provider. Check your network connection and try again." };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Ronin subscription provider ----------
// Built-in provider for subscription turns. It is NOT a BYOK
// provider: no user-supplied key is ever involved. Phase 2 dual-auth
// (design §5.3 / §6.2): in per-user mode the credential resolved at
// request time is the user's own delegated provider key (stored by
// AuthManager in the CredentialStore); in shared mode it is the
// session access token, exactly as in v1.
//
// Transport (Vercel consolidation): with config
// `subscriptionTransport: 'direct'` (the default), a per-user turn
// goes DIRECTLY from this host to the provider — POST
// {providerBaseUrl}/chat/completions with the delegated key — where
// providerBaseUrl was delivered by the credential endpoint alongside
// the key. The primary provider key is never involved. Transport
// 'relay', shared mode, or a credential without providerBaseUrl
// (older servers) all keep the v1 relay path exactly:
// POST {serverUrl}/v1/chat/completions, which accepts both
// credentials. Only the base URL (and therefore the endpoint) and
// the credential differ; the streaming path downstream is shared.

export const SUBSCRIPTION_PROVIDER_ID = "ronin-subscription";

/** The routing mode the manager reports ('per_user' | 'shared').
 *  Tolerates minimal test doubles that only know ensureFreshAccess. */
export function subscriptionRoutingModeOf(authManager) {
  if (!authManager) return "shared";
  if (typeof authManager.subscriptionRoutingMode === "function") {
    return authManager.subscriptionRoutingMode() === "per_user" ? "per_user" : "shared";
  }
  const sub = typeof authManager.state === "function" ? authManager.state()?.subscription : null;
  return sub?.routingMode === "per_user" ? "per_user" : "shared";
}

/** The provider base URL stored alongside the delegated key, or
 *  null when the server never delivered one. Tolerates minimal test
 *  doubles. Invalid / non-http(s) values are treated as absent, so
 *  the caller falls back to the relay. */
export function subscriptionProviderBaseUrlOf(authManager) {
  if (!authManager) return null;
  let raw = null;
  if (typeof authManager.getSubscriptionProviderBaseUrl === "function") {
    raw = authManager.getSubscriptionProviderBaseUrl();
  } else if (typeof authManager.getProviderBaseUrl === "function") {
    raw = authManager.getProviderBaseUrl();
  } else if (typeof authManager.providerBaseUrl === "string") {
    raw = authManager.providerBaseUrl;
  }
  if (typeof raw !== "string" || !raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

/** The configured subscription transport: host config
 *  `subscriptionTransport` ('direct' | 'relay', default 'direct'); a
 *  manager may override it (test doubles). */
export function subscriptionTransportConfigOf(authManager) {
  if (authManager) {
    if (typeof authManager.subscriptionTransport === "function") {
      const v = authManager.subscriptionTransport();
      if (v === "direct" || v === "relay") return v;
    } else if (authManager.subscriptionTransport === "direct" || authManager.subscriptionTransport === "relay") {
      return authManager.subscriptionTransport;
    }
  }
  return config.subscriptionTransport === "relay" ? "relay" : "direct";
}

/**
 * Resolve the transport for one subscription attempt:
 * 'direct' only when routing is per-user, the config flag is
 * 'direct', AND a provider base URL is on hand. Everything else is
 * 'relay' — the backward-compatible path.
 */
export function resolveSubscriptionTransport(authManager, routingMode, providerBaseUrl) {
  if (routingMode !== "per_user") return "relay";
  if (subscriptionTransportConfigOf(authManager) !== "direct") return "relay";
  return providerBaseUrl ? "direct" : "relay";
}

export const SUBSCRIPTION_PROVIDER = {
  id: SUBSCRIPTION_PROVIDER_ID,
  label: "Ronin Subscription",
  // Async key hook: providers elsewhere are sync objects with static
  // keys; this one resolves the live credential instead — the stored
  // delegated key in per-user mode (fetching it once first when
  // absent, §5.2), the fresh session token in shared mode.
  resolveApiKey: async (authManager) => {
    if (subscriptionRoutingModeOf(authManager) === "per_user") {
      if (typeof authManager.ensureSubscriptionKey === "function") {
        return authManager.ensureSubscriptionKey();
      }
      if (typeof authManager.getSubscriptionKey === "function") {
        return authManager.getSubscriptionKey();
      }
      return null;
    }
    return authManager.ensureFreshAccess();
  },
  // Relay base URL (v1 path). Direct attempts override this with the
  // provider base URL in buildSubscriptionAttempt.
  baseUrl: (authManager) => `${authManager.serverUrl()}/v1`,
  directBaseUrl: (authManager) => subscriptionProviderBaseUrlOf(authManager),
};

export const catalogModel = (modelId) => CATALOG.find((m) => m.id === modelId) || null;

export async function buildSubscriptionAttempt(authManager, { modelId, effort, fast } = {}) {
  const routingMode = subscriptionRoutingModeOf(authManager);
  // Whether a delegated key was already on hand BEFORE resolving:
  // the direct-transport upgrade fetch below must not double-fetch
  // when the resolve itself just fetched the credential.
  const hadKeyBefore =
    routingMode === "per_user" && typeof authManager.getSubscriptionKey === "function"
      ? Boolean(authManager.getSubscriptionKey())
      : false;
  let apiKey = await SUBSCRIPTION_PROVIDER.resolveApiKey(authManager);
  if (!apiKey) {
    if (routingMode === "per_user") {
      // Key still provisioning (pending_create / none): a transient
      // "setting up your key" state (§6.2) — NOT a credit or login
      // failure, and never the credit banner.
      const err = new Error("Your subscription key is still being set up. Please try again in a moment.");
      err.code = "provider_key_not_ready";
      throw err;
    }
    const err = new Error("Your Ronin session has ended. Please sign in again.");
    err.code = "login_required";
    throw err;
  }
  // Transport selection. Direct requires a provider base URL; a key
  // stored before the server started delivering one (upgrade case)
  // triggers exactly ONE credential re-fetch here to try to pick the
  // URL up — the credential endpoint is never the chat relay, so a
  // failed/absent URL still falls back to the relay below.
  let providerBaseUrl = subscriptionProviderBaseUrlOf(authManager);
  if (
    routingMode === "per_user" &&
    hadKeyBefore &&
    !providerBaseUrl &&
    subscriptionTransportConfigOf(authManager) === "direct" &&
    typeof authManager.refreshSubscriptionCredential === "function"
  ) {
    try { await authManager.refreshSubscriptionCredential(); } catch {}
    providerBaseUrl = subscriptionProviderBaseUrlOf(authManager);
    // The re-fetch may also have rotated the key — use the fresh one.
    if (typeof authManager.getSubscriptionKey === "function") {
      apiKey = authManager.getSubscriptionKey() || apiKey;
    }
  }
  const transport = resolveSubscriptionTransport(authManager, routingMode, providerBaseUrl);
  const meta = catalogModel(modelId);
  const { thinkingLevel, thinkingLevelMap } = effortToThinking(effort, meta);
  return {
    providerId: SUBSCRIPTION_PROVIDER_ID,
    apiKey,
    modelId,
    // Direct: the provider base URL (the engine appends
    // /chat/completions, same as for the relay's /v1 base). Relay:
    // the Ronin server's /v1, exactly as in v1.
    baseUrl: transport === "direct" ? providerBaseUrl : SUBSCRIPTION_PROVIDER.baseUrl(authManager),
    modelMeta: meta,
    thinkingLevel,
    thinkingLevelMap,
    fast: fast === true,
    routingMode,
    transport,
    providerBaseUrl: transport === "direct" ? providerBaseUrl : null,
  };
}

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Map a catalog reasoning effort to the engine's thinking level plus
 * the wire value it should produce. 'upstream'/unset → level 'off'
 * with no map entry, which makes the engine omit reasoning_effort
 * entirely so the upstream default applies. 'none' is a real wire
 * value for several catalog families: level 'off' mapped to 'none'
 * still emits reasoning_effort: "none". Anything else the engine
 * doesn't know (e.g. MiniMax 'thinking') rides the medium level with
 * an explicit map entry.
 */
export function effortToThinking(effort, _meta) {
  if (!effort || effort === "upstream") return { thinkingLevel: "off", thinkingLevelMap: undefined };
  if (PI_THINKING_LEVELS.has(effort)) return { thinkingLevel: effort, thinkingLevelMap: undefined };
  if (effort === "none") return { thinkingLevel: "off", thinkingLevelMap: { off: "none" } };
  return { thinkingLevel: "medium", thinkingLevelMap: { medium: effort } };
}

/**
 * Classify a relay failure surfaced through the engine (design §6.4).
 * Order matters: the specific codes are matched BEFORE the generic
 * status fallbacks — in particular `account_suspended` also arrives
 * with a 403, and must map to the suspended/locked state, never to
 * `model_disabled` (the §13 C5 fix).
 */
export function classifyProxyError(message) {
  const msg = String(message || "");
  if (/insufficient_credit/.test(msg) || /\b402\b/.test(msg)) return "insufficient_credit";
  if (/account_suspended/.test(msg)) return "account_suspended";
  if (/provider_key_not_ready/.test(msg)) return "provider_key_not_ready";
  if (/provider_key_invalid/.test(msg)) return "provider_key_invalid";
  if (/provider_forbidden/.test(msg)) return "provider_forbidden";
  if (/model_disabled/.test(msg)) return "model_disabled";
  if (/\b401\b/.test(msg) || /session_revoked|unauthorized/i.test(msg)) return "unauthorized";
  if (/\b403\b/.test(msg)) return "model_disabled";
  return null;
}

// ---------- starter project ----------

export function pickKey(providerId, auth, exclude = new Set()) {
  const keys = keyList(auth[providerId]);
  const usage = loadUsage();
  const usable = keys.filter((k) => {
    if (exclude.has(k)) return false;
    const s = usage.keys[`${providerId}:${keyIdOf(k)}`];
    return !(s && typeof s.cooldownUntil === "number" && s.cooldownUntil > Date.now());
  });
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const sa = usage.keys[`${providerId}:${keyIdOf(a)}`];
    const sb = usage.keys[`${providerId}:${keyIdOf(b)}`];
    return (sa?.lastUsedAt || 0) - (sb?.lastUsedAt || 0);
  });
  return usable[0];
}
/** Ordered provider list for a turn: active provider first, then failover order. */

export function providerChain(primaryId) {
  const order = [];
  const push = (id) => { if (id && providerById(id) && !order.includes(id)) order.push(id); };
  push(primaryId);
  if (config.failover) for (const id of config.failoverOrder) push(id);
  return order;
}

export const isFailoverError = (msg) =>
  /\b(429|500|502|503|504)\b|rate.?limit|quota|overloaded|too many requests|insufficient|capacity/i.test(msg || "");

// ---------- RTK-style tool-output compression ----------

export const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

export function compressToolText(text) {
  if (typeof text !== "string" || text.length < 800) return { text, saved: 0 };
  const original = text;
  let t = text.replace(ANSI_RE, "");
  // Collapse runs of blank lines.
  t = t.replace(/\n{3,}/g, "\n\n");
  // Dedupe consecutive repeated lines (log spam).
  const lines = t.split("\n");
  const deduped = [];
  let prev = null, run = 0;
  for (const line of lines) {
    if (line === prev && line.trim()) { run++; continue; }
    if (run > 0) deduped.push(`… (repeated ${run}×)`);
    deduped.push(line);
    prev = line; run = 0;
  }
  if (run > 0) deduped.push(`… (repeated ${run}×)`);
  t = deduped.join("\n");
  // Smart truncation: keep head + tail with a clear marker.
  const MAX = 6000;
  if (t.length > MAX) {
    const head = t.slice(0, 3800);
    const tail = t.slice(-1800);
    const dropped = t.length - 5600;
    t = `${head}\n… [${dropped} characters compressed by Ronin] …\n${tail}`;
  }
  const saved = Math.max(0, original.length - t.length);
  if (saved > 0) {
    const usage = loadUsage();
    usage.rtk.calls += 1;
    usage.rtk.originalChars += original.length;
    usage.rtk.compressedChars += t.length;
    saveUsage();
  }
  return { text: t, saved };
}

// ---------- secret redaction ----------

export function buildAttempts(auth) {
  const attempts = [];
  for (const providerId of providerChain(config.provider)) {
    const keys = keyList(auth[providerId]);
    if (!keys.length) continue;
    const usage = loadUsage();
    const sorted = [...keys].sort((a, b) => {
      const sa = usage.keys[`${providerId}:${keyIdOf(a)}`];
      const sb = usage.keys[`${providerId}:${keyIdOf(b)}`];
      const ca = sa && sa.cooldownUntil > Date.now() ? 1 : 0;
      const cb = sb && sb.cooldownUntil > Date.now() ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return (sa?.lastUsedAt || 0) - (sb?.lastUsedAt || 0);
    });
    for (const apiKey of sorted) {
      attempts.push({
        providerId,
        apiKey,
        modelId: providerId === config.provider ? currentModel() : providerById(providerId).defaultModel,
      });
    }
  }
  return attempts.slice(0, 4);
}
