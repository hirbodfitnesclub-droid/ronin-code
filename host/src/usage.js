// Ronin Code — local host service.
// Usage store (usage.json): per-key stats, RTK savings, per-turn records.
// Backs the router (rotation/cooldowns) and the cost center.

import crypto from "node:crypto";
import path from "node:path";
import { RONIN_HOME } from "./paths.js";
import { readJsonFile, writeJsonFile0600 } from "./util.js";

export const USAGE_PATH = path.join(RONIN_HOME, "usage.json");

export let usageCache = null;

export function loadUsage() {
  if (usageCache) return usageCache;
  const u = readJsonFile(USAGE_PATH, {});
  usageCache = {
    keys: u.keys && typeof u.keys === "object" ? u.keys : {},
    rtk: u.rtk && typeof u.rtk === "object" ? u.rtk : { calls: 0, originalChars: 0, compressedChars: 0 },
    turns: Array.isArray(u.turns) ? u.turns.slice(-300) : [],
  };
  return usageCache;
}

export function saveUsage() {
  if (!usageCache) return;
  try { writeJsonFile0600(USAGE_PATH, usageCache); } catch {}
}

export const keyIdOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 10);

export function keyStats(usage, providerId, key) {
  const s = usage.keys[`${providerId}:${keyIdOf(key)}`];
  if (!s) return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, coolingDown: false };
  return {
    requests: s.requests || 0,
    errors: s.errors || 0,
    inputTokens: s.inputTokens || 0,
    outputTokens: s.outputTokens || 0,
    coolingDown: typeof s.cooldownUntil === "number" && s.cooldownUntil > Date.now(),
  };
}

export function recordKeyUse(providerId, key, { error = false, inputTokens = 0, outputTokens = 0, cooldownMs = 0 } = {}) {
  const usage = loadUsage();
  const id = `${providerId}:${keyIdOf(key)}`;
  const s = usage.keys[id] || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cooldownUntil: 0, lastUsedAt: 0 };
  s.requests += 1;
  if (error) s.errors += 1;
  s.inputTokens += inputTokens || 0;
  s.outputTokens += outputTokens || 0;
  s.lastUsedAt = Date.now();
  if (cooldownMs > 0) s.cooldownUntil = Date.now() + cooldownMs;
  usage.keys[id] = s;
  saveUsage();
  return s;
}

export function recordTurnUsage(rec) {
  const usage = loadUsage();
  usage.turns.push(rec);
  if (usage.turns.length > 300) usage.turns = usage.turns.slice(-300);
  saveUsage();
}

export function sessionTotals() {
  const usage = loadUsage();
  const t = { turns: usage.turns.length, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const r of usage.turns) {
    t.inputTokens += r.inputTokens || 0;
    t.outputTokens += r.outputTokens || 0;
    t.costUsd += r.costUsd || 0;
  }
  t.costUsd = Math.round(t.costUsd * 1e6) / 1e6;
  return t;
}

// ---------- router: multi-key rotation + failover ----------
/** Pick the next usable key for a provider: round-robin, skipping cooled-down keys. */
