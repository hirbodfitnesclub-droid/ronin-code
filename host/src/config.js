// Ronin Code — local host service.
// Providers, persisted config (config.json) + credentials (auth.json),
// and the currently open project. `config` is a single mutable object —
// mutate fields, never reassign; the open project is reassigned at
// runtime, so it goes through getProject()/setProject().

import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, AUTH_PATH } from "./paths.js";
import { readJsonFile, writeJsonFile0600 } from "./util.js";
import { loadUsage, keyStats } from "./usage.js";

export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5" },
  { id: "google", label: "Google", defaultModel: "gemini-2.5-pro" },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-5" },
  { id: "custom", label: "Custom endpoint", defaultModel: "" },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id);

// ---------- small helpers ----------

export function loadConfig() {
  const c = readJsonFile(CONFIG_PATH, {});
  return {
    provider: providerById(c.provider) ? c.provider : "anthropic",
    model: typeof c.model === "string" && c.model ? c.model : null,
    project: typeof c.project === "string" && c.project ? c.project : null,
    baseUrl: typeof c.baseUrl === "string" && c.baseUrl ? c.baseUrl : null,
    // v1 fields
    onboarded: c.onboarded === true,
    language: c.language === "fa" ? "fa" : "en",
    autoMode: c.autoMode === true,
    planMode: c.planMode === true,
    failoverOrder: Array.isArray(c.failoverOrder)
      ? c.failoverOrder.filter((id) => providerById(id))
      : [],
    failover: c.failover !== false,
    budgetCapUsd:
      typeof c.budgetCapUsd === "number" && c.budgetCapUsd > 0 ? c.budgetCapUsd : null,
    envAllowedProjects:
      c.envAllowedProjects && typeof c.envAllowedProjects === "object" && !Array.isArray(c.envAllowedProjects)
        ? c.envAllowedProjects
        : {},
    projectModes:
      c.projectModes && typeof c.projectModes === "object" && !Array.isArray(c.projectModes)
        ? c.projectModes
        : {},
  };
}

export function loadAuth() {
  const a = readJsonFile(AUTH_PATH, {});
  return a && typeof a === "object" && !Array.isArray(a) ? a : {};
}
/** auth.json maps provider -> key string (legacy) or array of key strings. */

export function keyList(v) {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((k) => typeof k === "string" && k.length > 0);
  return [];
}

export function saveAuth(auth) {
  // Normalize to arrays on disk; keep file 0600 like all Ronin secrets.
  const out = {};
  for (const [k, v] of Object.entries(auth)) {
    const list = keyList(v);
    if (list.length) out[k] = list;
  }
  writeJsonFile0600(AUTH_PATH, out);
}

export function maskedKey(key) {
  if (!key || typeof key !== "string") return null;
  return "••••" + key.slice(-4);
}

export function providersView() {
  const auth = loadAuth();
  const usage = loadUsage();
  return PROVIDERS.map((p) => {
    const keys = keyList(auth[p.id]);
    return {
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      hasKey: keys.length > 0,
      maskedKey: maskedKey(keys[0]),
      keys: keys.map((k, i) => ({
        index: i,
        maskedKey: maskedKey(k),
        ...(keyStats(usage, p.id, k)),
      })),
      ...(p.id === "custom" ? { baseUrl: config.baseUrl || "" } : {}),
    };
  });
}

export function currentModel(cfg = config) {
  return cfg.model || providerById(cfg.provider).defaultModel;
}

export const config = loadConfig();

export let currentProject =
  config.project && fs.existsSync(config.project) && fs.statSync(config.project).isDirectory()
    ? config.project
    : null;
export function getProject() { return currentProject; }
export function setProject(p) { currentProject = p; }

export function saveConfig() {
  writeJsonFile0600(CONFIG_PATH, {
    provider: config.provider,
    model: currentModel(),
    project: currentProject,
    baseUrl: config.baseUrl || null,
    onboarded: config.onboarded,
    language: config.language,
    autoMode: config.autoMode,
    planMode: config.planMode,
    failoverOrder: config.failoverOrder,
    failover: config.failover,
    budgetCapUsd: config.budgetCapUsd,
    envAllowedProjects: config.envAllowedProjects,
    projectModes: config.projectModes,
  });
}

/** Per-project execution mode: 'auto' | 'plan' | null (fall back to global toggles). */

export function projectMode(project = currentProject) {
  if (!project) return null;
  const m = config.projectModes[path.resolve(project)];
  return m === "auto" || m === "plan" ? m : null;
}

export function effectiveAutoMode(project = currentProject) {
  const pm = projectMode(project);
  if (pm === "auto") return true;
  if (pm === "plan") return false;
  return config.autoMode;
}

export function effectivePlanMode(project = currentProject) {
  const pm = projectMode(project);
  if (pm === "plan") return true;
  if (pm === "auto") return false; // "just build it" — no plan gate in auto mode
  return config.planMode;
}

// ---------- snapshots ----------
