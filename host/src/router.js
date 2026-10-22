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
// Built-in provider backed by the Ronin server's metering proxy
// (POST /v1/chat/completions on the account server). It is NOT a BYOK
// provider: there is no stored key — the session access token is
// resolved at request time via resolveApiKey (AuthManager), so token
// rotation/revocation is picked up on every turn.

export const SUBSCRIPTION_PROVIDER_ID = "ronin-subscription";

export const SUBSCRIPTION_PROVIDER = {
  id: SUBSCRIPTION_PROVIDER_ID,
  label: "Ronin Subscription",
  // Async key hook: providers elsewhere are sync objects with static
  // keys; this one awaits a fresh session token instead.
  resolveApiKey: async (authManager) => authManager.ensureFreshAccess(),
  baseUrl: (authManager) => `${authManager.serverUrl()}/v1`,
};

export const catalogModel = (modelId) => CATALOG.find((m) => m.id === modelId) || null;

export async function buildSubscriptionAttempt(authManager, { modelId, effort, fast } = {}) {
  const apiKey = await SUBSCRIPTION_PROVIDER.resolveApiKey(authManager);
  if (!apiKey) {
    const err = new Error("Your Ronin session has ended. Please sign in again.");
    err.code = "login_required";
    throw err;
  }
  const meta = catalogModel(modelId);
  const { thinkingLevel, thinkingLevelMap } = effortToThinking(effort, meta);
  return {
    providerId: SUBSCRIPTION_PROVIDER_ID,
    apiKey,
    modelId,
    baseUrl: SUBSCRIPTION_PROVIDER.baseUrl(authManager),
    modelMeta: meta,
    thinkingLevel,
    thinkingLevelMap,
    fast: fast === true,
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

/** Classify a metering-proxy failure surfaced through the engine. */
export function classifyProxyError(message) {
  const msg = String(message || "");
  if (/insufficient_credit/.test(msg) || /\b402\b/.test(msg)) return "insufficient_credit";
  if (/\b401\b/.test(msg) || /session_revoked|unauthorized/i.test(msg)) return "unauthorized";
  if (/model_disabled/.test(msg) || /\b403\b/.test(msg)) return "model_disabled";
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
