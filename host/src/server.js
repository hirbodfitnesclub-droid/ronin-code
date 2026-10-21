// Ronin Code — local host service.
// Plain ESM Node (>=20), node:http + stdlib only. The embedded agent engine
// is loaded lazily, only for live turns (see ENGINE.md for the exact SDK API).

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUI_DIST = path.resolve(HOST_DIR, "..", "gui", "dist");
const VERSION = "0.1.0";
const PORT = Number(process.env.PORT || 7331);
const TOKEN = crypto.randomBytes(24).toString("hex");

const RONIN_HOME = process.env.RONIN_HOME
  ? path.resolve(process.env.RONIN_HOME)
  : path.join(os.homedir(), ".ronin-code");
const ENGINE_DIR = path.join(RONIN_HOME, "engine");
const SESSIONS_DIR = path.join(RONIN_HOME, "sessions");
const SNAPSHOTS_DIR = path.join(RONIN_HOME, "snapshots");
const CONFIG_PATH = path.join(RONIN_HOME, "config.json");
const AUTH_PATH = path.join(RONIN_HOME, "auth.json");

// Keep every engine-native file inside the Ronin data dir (never ~/.pi).
process.env.PI_CODING_AGENT_DIR = ENGINE_DIR;

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5" },
  { id: "google", label: "Google", defaultModel: "gemini-2.5-pro" },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-5" },
  { id: "custom", label: "Custom endpoint", defaultModel: "" },
];
const providerById = (id) => PROVIDERS.find((p) => p.id === id);

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFile0600(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function loadConfig() {
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
function loadAuth() {
  const a = readJsonFile(AUTH_PATH, {});
  return a && typeof a === "object" && !Array.isArray(a) ? a : {};
}
/** auth.json maps provider -> key string (legacy) or array of key strings. */
function keyList(v) {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((k) => typeof k === "string" && k.length > 0);
  return [];
}
function saveAuth(auth) {
  // Normalize to arrays on disk; keep file 0600 like all Ronin secrets.
  const out = {};
  for (const [k, v] of Object.entries(auth)) {
    const list = keyList(v);
    if (list.length) out[k] = list;
  }
  writeJsonFile0600(AUTH_PATH, out);
}
function maskedKey(key) {
  if (!key || typeof key !== "string") return null;
  return "••••" + key.slice(-4);
}
function providersView() {
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
function currentModel(cfg = config) {
  return cfg.model || providerById(cfg.provider).defaultModel;
}
function cleanError(err) {
  let msg = (err && err.message) || String(err || "Unknown error");
  // Never surface internal engine branding/names to the user.
  msg = msg.replace(/@earendil-works\/[a-z-]+/gi, "Ronin Code engine");
  msg = msg.replace(/\bpi-coding-agent\b/gi, "Ronin Code engine");
  return msg.slice(0, 500);
}

fs.mkdirSync(RONIN_HOME, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
fs.mkdirSync(ENGINE_DIR, { recursive: true });

let config = loadConfig();
let currentProject =
  config.project && fs.existsSync(config.project) && fs.statSync(config.project).isDirectory()
    ? config.project
    : null;

function saveConfig() {
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
function projectMode(project = currentProject) {
  if (!project) return null;
  const m = config.projectModes[path.resolve(project)];
  return m === "auto" || m === "plan" ? m : null;
}
function effectiveAutoMode(project = currentProject) {
  const pm = projectMode(project);
  if (pm === "auto") return true;
  if (pm === "plan") return false;
  return config.autoMode;
}
function effectivePlanMode(project = currentProject) {
  const pm = projectMode(project);
  if (pm === "plan") return true;
  if (pm === "auto") return false; // "just build it" — no plan gate in auto mode
  return config.planMode;
}

// ---------- snapshots ----------
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 2000;

function projectHash(project) {
  return crypto.createHash("sha256").update(path.resolve(project)).digest("hex").slice(0, 16);
}
async function walkProject(project) {
  const files = [];
  async function walk(dir) {
    if (files.length >= MAX_FILES) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        try {
          const st = await fsp.stat(full);
          if (st.size > MAX_FILE) continue;
          const hash = crypto.createHash("sha256").update(await fsp.readFile(full)).digest("hex");
          files.push({ path: path.relative(project, full), size: st.size, hash });
        } catch {}
      }
    }
  }
  await walk(project);
  return files;
}

async function takeSnapshot(project) {
  const hash = projectHash(project);
  const base = path.join(SNAPSHOTS_DIR, hash);
  const latest = path.join(base, "latest");
  await fsp.rm(latest, { recursive: true, force: true });
  await fsp.mkdir(latest, { recursive: true });
  const files = await walkProject(project);
  for (const f of files) {
    const dest = path.join(latest, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(project, f.path), dest);
  }
  const manifest = { project: path.resolve(project), timestamp: new Date().toISOString(), files };
  await fsp.mkdir(base, { recursive: true });
  await fsp.writeFile(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readManifest(project) {
  try {
    return JSON.parse(await fsp.readFile(path.join(SNAPSHOTS_DIR, projectHash(project), "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

async function diffAgainstManifest(project, manifest) {
  if (!manifest) return [];
  const before = new Map(manifest.files.map((f) => [f.path, f.hash]));
  const after = await walkProject(project);
  const changes = [];
  for (const f of after) {
    if (!before.has(f.path)) changes.push({ path: f.path, action: "created" });
    else if (before.get(f.path) !== f.hash) changes.push({ path: f.path, action: "modified" });
  }
  return changes;
}

// ---------- SSE ----------
const sseClients = new Set();
let eventSeq = 0;
function broadcast(obj) {
  const evt = { id: ++eventSeq, ...obj };
  const data = `id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
  return evt;
}

// ---------- HTTP helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};
const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return false;
  // host may be "name", "name:port", "[::1]" or "[::1]:port"
  let h;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    h = host.slice(0, end + 1);
  } else {
    h = host.split(":")[0];
  }
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}
function tokenOk(req, url) {
  return req.headers["x-ronin-token"] === TOKEN || url.searchParams.get("token") === TOKEN;
}
function safeJoin(base, rel) {
  const target = path.resolve(base, "." + path.sep + rel);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

// ---------- provider key test ----------
async function testProviderKey(providerId, apiKey, baseUrl) {
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

// ---------- starter project ----------
const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ronin Code — Starter</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<main class="card">
  <div class="mark">⚔</div>
  <h1>Ronin Code Starter</h1>
  <p>Your project is live. Ask Ronin Code to change this page — restyle it, add a section, make it yours.</p>
  <button id="hello">Say hello</button>
  <p id="out" class="out"></p>
</main>
<script src="app.js"></script>
</body>
</html>
`;
const STARTER_CSS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0e14; color: #e6e9ef;
  font-family: ui-sans-system, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.card { max-width: 520px; padding: 48px 40px; text-align: center; background: #121722; border: 1px solid #232b3d;
  border-radius: 20px; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
.mark { font-size: 40px; }
h1 { margin: 14px 0 10px; font-size: 28px; letter-spacing: -.02em; }
p { color: #9aa4b8; line-height: 1.6; }
button { margin-top: 14px; padding: 11px 22px; border: 0; border-radius: 999px; background: #e8b33c; color: #171106;
  font-weight: 600; cursor: pointer; }
button:hover { filter: brightness(1.08); }
.out { min-height: 1.5em; color: #e8b33c; }
`;
const STARTER_JS = `document.getElementById("hello").addEventListener("click", () => {
  document.getElementById("out").textContent = "Hello from your Ronin Code starter project.";
});
`;

// ---------- usage store (cost center + router stats) ----------
const USAGE_PATH = path.join(RONIN_HOME, "usage.json");
let usageCache = null;
function loadUsage() {
  if (usageCache) return usageCache;
  const u = readJsonFile(USAGE_PATH, {});
  usageCache = {
    keys: u.keys && typeof u.keys === "object" ? u.keys : {},
    rtk: u.rtk && typeof u.rtk === "object" ? u.rtk : { calls: 0, originalChars: 0, compressedChars: 0 },
    turns: Array.isArray(u.turns) ? u.turns.slice(-300) : [],
  };
  return usageCache;
}
function saveUsage() {
  if (!usageCache) return;
  try { writeJsonFile0600(USAGE_PATH, usageCache); } catch {}
}
const keyIdOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 10);
function keyStats(usage, providerId, key) {
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
function recordKeyUse(providerId, key, { error = false, inputTokens = 0, outputTokens = 0, cooldownMs = 0 } = {}) {
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
function recordTurnUsage(rec) {
  const usage = loadUsage();
  usage.turns.push(rec);
  if (usage.turns.length > 300) usage.turns = usage.turns.slice(-300);
  saveUsage();
}
function sessionTotals() {
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
function pickKey(providerId, auth, exclude = new Set()) {
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
function providerChain(primaryId) {
  const order = [];
  const push = (id) => { if (id && providerById(id) && !order.includes(id)) order.push(id); };
  push(primaryId);
  if (config.failover) for (const id of config.failoverOrder) push(id);
  return order;
}
const isFailoverError = (msg) =>
  /\b(429|500|502|503|504)\b|rate.?limit|quota|overloaded|too many requests|insufficient|capacity/i.test(msg || "");

// ---------- RTK-style tool-output compression ----------
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;
function compressToolText(text) {
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
const SECRET_PATTERNS = [
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g,                 // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                  // Anthropic keys
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,                     // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                 // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,               // Slack tokens
  /\bAKIA[A-Z0-9]{16}\b/g,                           // AWS access keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi,
];
function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) => (p1 ? `${p1}"••••"` : "••••"));
  }
  return out;
}
function collectSecretValues() {
  const vals = new Set();
  const auth = loadAuth();
  for (const v of Object.values(auth)) for (const k of keyList(v)) if (k.length >= 8) vals.add(k);
  return [...vals];
}
function redactKnownSecrets(text, values) {
  let out = redactSecrets(text);
  for (const v of values || []) out = out.split(v).join("••••");
  return out;
}

// ---------- .env protection ----------
function isEnvPath(p, project) {
  if (typeof p !== "string" || !p) return false;
  const abs = path.resolve(project || currentProject || "/", p.startsWith("/") || /^[a-zA-Z]:/.test(p) ? p : path.join(project || "", p));
  const base = path.basename(abs);
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") return false;
  return base === ".env" || base.startsWith(".env.");
}
function envAccessAllowed(project = currentProject) {
  return project ? config.envAllowedProjects[path.resolve(project)] === true : false;
}

// ---------- approvals ----------
const pendingApprovals = new Map(); // id -> { resolve, kind, detail }
function requestApproval(kind, detail) {
  const id = crypto.randomUUID();
  broadcast({ type: "approval_request", approvalId: id, kind, detail });
  return new Promise((resolve) => {
    pendingApprovals.set(id, { resolve });
    // Safety valve: never hang a turn forever.
    setTimeout(() => {
      if (pendingApprovals.delete(id)) resolve(false);
    }, 10 * 60 * 1000);
  });
}
function resolveApproval(id, approved) {
  const p = pendingApprovals.get(id);
  if (!p) return false;
  pendingApprovals.delete(id);
  broadcast({ type: "approval_resolved", approvalId: id, approved });
  p.resolve(approved);
  return true;
}

// ---------- turns ----------
let turnRunning = false;
let activitySeq = 0;
const nextActivityId = () => `act-${++activitySeq}`;

function emitActivity(kind, ms) {
  const activityId = nextActivityId();
  broadcast({ type: "activity_start", activityId, kind });
  return { activityId, kind, async end() { broadcast({ type: "activity_end", activityId, kind }); } };
}
async function runActivity(kind, ms) {
  const a = emitActivity(kind, ms);
  await sleep(ms);
  await a.end();
}

async function runPreviewTurn() {
  await runActivity("planning", 900);
  await runActivity("reading", 650);
  await runActivity("searching", 600);
  const message =
    "You're in Preview mode, so I explored your project and planned the work — but I didn't change any files. " +
    "Add an API key for your provider in Settings to switch to Live mode, and I'll make real edits, run commands, and show you exactly what changed.";
  for (const chunk of ["You're in Preview mode — ", "add an API key in Settings ", "to switch to Live mode."]) {
    broadcast({ type: "assistant_delta", text: chunk });
    await sleep(250);
  }
  await runActivity("writing", 750);
  await runActivity("terminal", 700);
  await runActivity("editing", 650);
  await runActivity("reviewing", 800);
  broadcast({ type: "assistant_message", text: message });
  broadcast({ type: "changes", files: [] });
  finalizeTurnUsage({ providerId: config.provider, modelId: currentModel(), apiKey: null, usage: null, promptText: "", replyText: message });
  broadcast({ type: "turn_done" });
}

const TOOL_KIND = {
  read: "reading",
  write: "writing",
  edit: "editing",
  bash: "terminal",
  powershell: "terminal",
  grep: "searching",
  find: "searching",
  ls: "searching",
  search: "searching",
};

// ---------- price table (server-side; GUI never prices anything) ----------
// USD per 1M tokens. `multiplier` scales consumption (subscription-style
// accounting, mirrored into cost so expensive models weigh more).
const PRICE_TABLE = {
  "claude-sonnet-4-5": { input: 3, output: 15, multiplier: 1 },
  "gpt-5": { input: 1.25, output: 10, multiplier: 1 },
  "gemini-2.5-pro": { input: 1.25, output: 10, multiplier: 1 },
  "openai/gpt-5": { input: 1.25, output: 10, multiplier: 1 },
};
const DEFAULT_PRICE = { input: 0.5, output: 2, multiplier: 1 };
function priceTurn(modelId, inputTokens, outputTokens, engineCost) {
  if (typeof engineCost === "number" && engineCost > 0) {
    return { costUsd: Math.round(engineCost * 1e6) / 1e6, estimated: false };
  }
  const p = PRICE_TABLE[modelId] || DEFAULT_PRICE;
  const cost =
    ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * (p.multiplier || 1);
  return { costUsd: Math.round(cost * 1e6) / 1e6, estimated: true };
}

function finalizeTurnUsage({ providerId, modelId, apiKey, usage, promptText, replyText, error }) {
  let inputTokens = usage?.input || 0;
  let outputTokens = usage?.output || 0;
  let estimated = false;
  if (!inputTokens && !outputTokens) {
    // Char-based estimate when the engine reported no usage.
    inputTokens = Math.ceil((promptText || "").length / 4);
    outputTokens = Math.ceil((replyText || "").length / 4);
    estimated = true;
  }
  const { costUsd, estimated: priceEstimated } = priceTurn(modelId, inputTokens, outputTokens, usage?.costTotal);
  const rec = {
    ts: new Date().toISOString(),
    provider: providerId,
    model: modelId,
    inputTokens,
    outputTokens,
    costUsd,
    estimated: estimated || priceEstimated,
  };
  recordTurnUsage(rec);
  if (apiKey) {
    recordKeyUse(providerId, apiKey, {
      error: !!error,
      inputTokens,
      outputTokens,
      cooldownMs: error && /429|rate.?limit|quota/i.test(error) ? 90_000 : error && /5\d\d|overloaded/i.test(error) ? 30_000 : 0,
    });
  }
  broadcast({
    type: "turn_usage",
    provider: providerId,
    model: modelId,
    inputTokens,
    outputTokens,
    costUsd,
    estimated: rec.estimated,
    sessionTotalUsd: sessionTotals().costUsd,
  });
  const cap = config.budgetCapUsd;
  if (cap) {
    const total = sessionTotals().costUsd;
    if (total >= cap) broadcast({ type: "budget_exceeded", capUsd: cap, totalUsd: total });
    else if (total >= cap * 0.8) broadcast({ type: "budget_warning", capUsd: cap, totalUsd: total });
  }
  return rec;
}

/**
 * Build the inline engine extension that enforces Ronin's trust layer:
 * approval gates, .env protection, secret redaction and RTK compression.
 * Runs inside the engine process via extensionFactories (see ENGINE.md).
 */
function makeGuardExtension({ project, autoMode, secretValues }) {
  const insideProject = (abs) => {
    const rel = path.relative(path.resolve(project), abs);
    return rel === "" || (!rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  };
  const resolveArgPath = (p) =>
    typeof p === "string" && p ? path.resolve(project, p) : null;
  const envBlockedReason =
    "Blocked by Ronin Code: .env files are protected because they usually hold secrets. " +
    "If the user truly needs this, they can enable .env access for this project in Settings. Continue without it.";
  const bashTouchesEnv = (cmd) =>
    /(^|[\s;|&])(?:cat|less|more|head|tail|cp|mv|rm|source|\.|grep|sed|awk|tee)\s+[^|&;]*\.env(\.|\s|$|["'])/.test(cmd) &&
    !/\.env\.(example|sample|template)/.test(cmd);

  return (pi) => {
    pi.on("tool_call", async (event) => {
      const tool = event.toolName;
      const input = event.input || {};
      // --- .env protection (reads, writes, searches, shell) ---
      if (!envAccessAllowed(project)) {
        if ((tool === "read" || tool === "write" || tool === "edit") && isEnvPath(input.path, project)) {
          return { block: true, reason: envBlockedReason };
        }
        if ((tool === "grep" || tool === "find" || tool === "ls") && input.path && isEnvPath(input.path, project)) {
          return { block: true, reason: envBlockedReason };
        }
        if ((tool === "bash" || tool === "powershell") && typeof input.command === "string" && bashTouchesEnv(input.command)) {
          return { block: true, reason: envBlockedReason };
        }
      }
      // --- approval gate ---
      if (autoMode) return undefined;
      if (tool === "bash" || tool === "powershell") {
        const ok = await requestApproval("command", {
          tool,
          command: String(input.command || "").slice(0, 600),
          project,
        });
        if (!ok) return { block: true, reason: "The user declined this command in Ronin Code. Continue without running it, or ask what they would prefer." };
      } else if (tool === "write" || tool === "edit") {
        const abs = resolveArgPath(input.path);
        if (abs && !insideProject(abs)) {
          const ok = await requestApproval("write_outside", { tool, path: abs, project });
          if (!ok) return { block: true, reason: "The user declined writing outside the project in Ronin Code. Keep changes inside the project folder." };
        }
      }
      return undefined;
    });

    pi.on("tool_result", async (event) => {
      if (!["bash", "powershell", "read", "grep", "find", "ls"].includes(event.toolName)) return undefined;
      if (!Array.isArray(event.content)) return undefined;
      let changed = false;
      const content = event.content.map((part) => {
        if (!part || part.type !== "text" || typeof part.text !== "string") return part;
        let text = redactKnownSecrets(part.text, secretValues);
        text = compressToolText(text).text;
        if (text !== part.text) changed = true;
        return { ...part, text };
      });
      return changed ? { content } : undefined;
    });
  };
}

/** One live attempt against one provider+key. Throws on engine/provider failure. */
async function runLiveAttempt({ prompt, providerId, modelId, apiKey, project, manifest, autoMode, onProgress, state }) {
  // Embedded engine — actual installed SDK API (v1.3.0, see ENGINE.md).
  const engine = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader } = engine;

  if (providerId === "custom") {
    // Register the user's own OpenAI-compatible endpoint with the engine.
    // The key itself never lands in models.json — it is referenced through
    // an environment variable that only this host process sets.
    if (!config.baseUrl) throw new Error("No endpoint URL is configured for the custom provider.");
    process.env.RONIN_CUSTOM_KEY = apiKey;
    const modelsDoc = {
      providers: {
        custom: {
          baseUrl: config.baseUrl,
          api: "openai-completions",
          apiKey: "$RONIN_CUSTOM_KEY",
          models: [{ id: modelId, name: modelId, contextWindow: 1048576, maxTokens: 32768 }],
        },
      },
    };
    fs.writeFileSync(path.join(ENGINE_DIR, "models.json"), JSON.stringify(modelsDoc, null, 2) + "\n", { mode: 0o600 });
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(ENGINE_DIR, "auth.json"),
    modelsPath: path.join(ENGINE_DIR, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) throw new Error(`Model "${modelId}" is not available for this provider.`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const sessionManager = SessionManager.create(project, SESSIONS_DIR);

  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir: ENGINE_DIR,
    settingsManager,
    extensionFactories: [
      { name: "ronin-guard", factory: makeGuardExtension({ project, autoMode, secretValues: collectSecretValues() }) },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: project,
    agentDir: ENGINE_DIR,
    modelRuntime,
    model,
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  const toolActivities = new Map(); // toolCallId -> {activityId, kind}
  const trackedFiles = new Map(); // relPath -> action
  let thinkingId = null;
  let thinkingKind = "thinking";
  let toolCount = 0;
  let toolEnds = 0;
  let editedDone = false;
  let assistantText = "";
  const usage = { input: 0, output: 0, costTotal: 0 };

  const endThinking = () => {
    if (thinkingId) {
      broadcast({ type: "activity_end", activityId: thinkingId, kind: thinkingKind });
      thinkingId = null;
    }
  };

  const unsubscribe = session.subscribe((event) => {
    try {
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent || {};
        if (ame.type === "thinking_start" || ame.type === "thinking_delta") {
          if (!thinkingId) {
            thinkingId = nextActivityId();
            // Reasoning before the first tool call of a turn is the agent
            // planning the work; later reasoning is plain thinking.
            thinkingKind = toolCount === 0 ? "planning" : "thinking";
            broadcast({ type: "activity_start", activityId: thinkingId, kind: thinkingKind });
          }
        } else if (ame.type === "thinking_end") {
          endThinking();
        } else if (ame.type === "text_delta" && typeof ame.delta === "string") {
          endThinking();
          if (state) state.visible = true;
          assistantText += ame.delta;
          broadcast({ type: "assistant_delta", text: ame.delta });
        }
      } else if (event.type === "message_end") {
        const u = event.message && event.message.usage;
        if (u) {
          usage.input += u.input || 0;
          usage.output += u.output || 0;
          usage.costTotal += (u.cost && u.cost.total) || 0;
        }
      } else if (event.type === "tool_execution_start") {
        endThinking();
        if (state) state.visible = true;
        toolCount++;
        let kind = TOOL_KIND[event.toolName] || "reading";
        // Reading/searching again after an edit is the agent reviewing
        // its own work — give it its own visual state.
        if ((kind === "reading" || kind === "searching") && editedDone) kind = "reviewing";
        const activityId = nextActivityId();
        toolActivities.set(event.toolCallId, { activityId, kind });
        broadcast({ type: "activity_start", activityId, kind });
        if ((event.toolName === "write" || event.toolName === "edit") && event.args) {
          const p = event.args.path || event.args.file_path || event.args.filePath;
          if (typeof p === "string") {
            const rel = path.isAbsolute(p) ? path.relative(project, p) : p;
            if (rel && !rel.startsWith("..")) trackedFiles.set(rel, event.toolName === "write" ? "created" : "modified");
          }
        }
      } else if (event.type === "tool_execution_end") {
        if (event.toolName === "write" || event.toolName === "edit") editedDone = true;
        toolEnds++;
        if (onProgress) onProgress({ toolEnds });
        const a = toolActivities.get(event.toolCallId);
        if (a) {
          toolActivities.delete(event.toolCallId);
          broadcast({ type: "activity_end", activityId: a.activityId, kind: a.kind });
        }
      }
    } catch {}
  });

  try {
    await session.prompt(prompt);
    endThinking();
    for (const a of toolActivities.values()) broadcast({ type: "activity_end", activityId: a.activityId, kind: a.kind });
    toolActivities.clear();

    let finalText = assistantText;
    try {
      const last = typeof session.getLastAssistantText === "function" ? session.getLastAssistantText() : undefined;
      if (typeof last === "string" && last.trim()) finalText = last;
    } catch {}

    let changes = await diffAgainstManifest(project, manifest);
    if (!changes.length && trackedFiles.size) {
      changes = [...trackedFiles.entries()].map(([p, action]) => ({ path: p, action }));
    } else if (trackedFiles.size) {
      const seen = new Set(changes.map((c) => c.path));
      for (const [p, action] of trackedFiles) if (!seen.has(p)) changes.push({ path: p, action });
    }
    return { finalText: finalText || "Done.", changes, usage, toolCount };
  } finally {
    try { unsubscribe(); } catch {}
    try { session.dispose(); } catch {}
  }
}

/** Attempts list for a turn: primary provider keys (rotated), then failover providers. */
function buildAttempts(auth) {
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

let lastTurnDiff = null; // { project, manifest, changes } for the diff view

async function runLiveTurn(prompt, project, manifest, { autoMode, onProgress } = {}) {
  const auth = loadAuth();
  const attempts = buildAttempts(auth);
  if (!attempts.length) throw new Error("No usable API key is available right now.");
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (i > 0) broadcast({ type: "provider_switched", provider: a.providerId, model: a.modelId });
    const state = { visible: false };
    try {
      const r = await runLiveAttempt({ prompt, ...a, project, manifest, autoMode, onProgress, state });
      finalizeTurnUsage({ providerId: a.providerId, modelId: a.modelId, apiKey: a.apiKey, usage: r.usage, promptText: prompt, replyText: r.finalText });
      broadcast({ type: "assistant_message", text: r.finalText });
      broadcast({ type: "changes", files: r.changes });
      lastTurnDiff = { project, manifest, changes: r.changes };
      broadcast({ type: "turn_done" });
      return;
    } catch (e) {
      lastError = e;
      const msg = cleanError(e);
      finalizeTurnUsage({ providerId: a.providerId, modelId: a.modelId, apiKey: a.apiKey, usage: null, promptText: prompt, replyText: "", error: msg });
      // Fail over only when nothing user-visible happened yet (no streamed
      // text, no tool ran) and the error looks like a provider problem.
      if (state.visible || !isFailoverError(msg) || i === attempts.length - 1) throw e;
      console.error(`Ronin Code: ${a.providerId} failed (${msg}); failing over.`);
    }
  }
  if (lastError) throw lastError;
}

// ---------- plan mode ----------
let pendingPlan = null; // { id, task, steps: [{title, detail}], project }
const previewSteps = () =>
  config.language === "fa"
    ? [
        { title: "مرور پروژه", detail: "نگاهی به ساختار و فایل‌های فعلی" },
        { title: "طراحی راه‌حل", detail: "انتخاب بهترین مسیر اجرا" },
        { title: "ساخت تغییرات", detail: "پیاده‌سازی قدم‌به‌قدم" },
        { title: "بازبینی و پولیش", detail: "بررسی نتیجه و رفع ایرادها" },
      ]
    : [
        { title: "Explore the project", detail: "Look through the current files and structure" },
        { title: "Design the approach", detail: "Choose the cleanest way to build it" },
        { title: "Build the changes", detail: "Implement it step by step" },
        { title: "Review and polish", detail: "Check the result and fix rough edges" },
      ];

function parseJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

/** A tools-free engine call that must answer with JSON. Used by plan + idea flows. */
async function runJsonPrompt(promptText, project) {
  const auth = loadAuth();
  const attempts = buildAttempts(auth);
  if (!attempts.length) return null;
  const a = attempts[0];
  const engine = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = engine;
  if (a.providerId === "custom") {
    if (!config.baseUrl) return null;
    process.env.RONIN_CUSTOM_KEY = a.apiKey;
    const modelsDoc = {
      providers: {
        custom: {
          baseUrl: config.baseUrl,
          api: "openai-completions",
          apiKey: "$RONIN_CUSTOM_KEY",
          models: [{ id: a.modelId, name: a.modelId, contextWindow: 1048576, maxTokens: 32768 }],
        },
      },
    };
    fs.writeFileSync(path.join(ENGINE_DIR, "models.json"), JSON.stringify(modelsDoc, null, 2) + "\n", { mode: 0o600 });
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(ENGINE_DIR, "auth.json"),
    modelsPath: path.join(ENGINE_DIR, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey(a.providerId, a.apiKey);
  const model = modelRuntime.getModel(a.providerId, a.modelId);
  if (!model) return null;
  const { session } = await createAgentSession({
    cwd: project,
    agentDir: ENGINE_DIR,
    modelRuntime,
    model,
    sessionManager: SessionManager.create(project, SESSIONS_DIR),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 1 } }),
    noTools: "all",
  });
  try {
    await session.prompt(promptText);
    const text = typeof session.getLastAssistantText === "function" ? session.getLastAssistantText() : "";
    const stats = typeof session.getSessionStats === "function" ? session.getSessionStats() : null;
    if (stats) {
      finalizeTurnUsage({
        providerId: a.providerId, modelId: a.modelId, apiKey: a.apiKey,
        usage: { input: stats.tokens?.input || 0, output: stats.tokens?.output || 0, costTotal: stats.cost || 0 },
        promptText, replyText: text || "",
      });
    }
    return text || "";
  } finally {
    try { session.dispose(); } catch {}
  }
}

async function proposePlan(task, project) {
  const auth = loadAuth();
  if (!keyList(auth[config.provider]).length) {
    await runActivity("planning", 900);
    return { steps: previewSteps(), simulated: true };
  }
  const activity = emitActivity("planning");
  try {
    const text = await runJsonPrompt(
      `You are planning a coding task inside a project. Do not use tools. ` +
      `Reply with ONLY a JSON object: {"steps":[{"title":"short step title","detail":"one short sentence"}]} ` +
      `with 3-6 steps, in the same language as the task.\n\nTask: ${task}`,
      project,
    );
    const parsed = parseJsonBlock(text || "");
    if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) {
      return {
        steps: parsed.steps.slice(0, 8).map((s) => ({
          title: String(s.title || "Step").slice(0, 120),
          detail: String(s.detail || "").slice(0, 240),
        })),
        simulated: false,
      };
    }
  } catch (e) {
    console.error("Ronin Code: plan proposal failed:", cleanError(e));
  } finally {
    await activity.end();
  }
  return { steps: previewSteps(), simulated: true };
}

async function executePlannedTurn(plan) {
  const project = currentProject;
  let manifest = null;
  try { manifest = await takeSnapshot(project); } catch {}
  const stepStates = plan.steps.map(() => "pending");
  const emitProgress = () =>
    broadcast({ type: "plan_progress", planId: plan.id, steps: plan.steps.map((s, i) => ({ ...s, state: stepStates[i] })) });
  stepStates[0] = "active";
  emitProgress();
  const planPrompt =
    `${plan.task}\n\nApproved plan — follow it step by step:\n` +
    plan.steps.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join("\n");
  const onProgress = ({ toolEnds }) => {
    // Roughly two tool actions per step; the final turn_done completes all.
    const doneCount = Math.min(plan.steps.length - 1, Math.floor(toolEnds / 2));
    for (let i = 0; i < plan.steps.length; i++) {
      stepStates[i] = i < doneCount ? "done" : i === doneCount ? "active" : "pending";
    }
    emitProgress();
  };
  const auth = loadAuth();
  if (!keyList(auth[config.provider]).length) {
    // Preview execution: walk the visual sequence, ticking steps as we go.
    const phases = ["reading", "writing", "terminal", "reviewing"];
    for (let i = 0; i < plan.steps.length; i++) {
      stepStates[i] = "active";
      emitProgress();
      await runActivity(phases[i % phases.length], 650);
      stepStates[i] = "done";
      emitProgress();
    }
    broadcast({ type: "assistant_message", text: "Preview mode — this plan would run for real with an API key saved in Settings." });
    broadcast({ type: "changes", files: [] });
    broadcast({ type: "turn_done" });
    return;
  }
  // runLiveTurn broadcasts turn_done; the GUI completes remaining plan
  // steps locally when the turn finishes.
  await runLiveTurn(planPrompt, project, manifest, { autoMode: effectiveAutoMode(project), onProgress });
}

// ---------- idea maturation ----------
async function matureIdea(idea, project) {
  const auth = loadAuth();
  const live = keyList(auth[config.provider]).length > 0;
  if (live) {
    const text = await runJsonPrompt(
      `A user has a one-line product idea. Mature it. Do not use tools. Reply with ONLY JSON: ` +
      `{"audience":{"who":"...","pain":"..."}, "features":["...","..."], "plan":[{"title":"...","detail":"..."}]} ` +
      `— 4-6 features, 3-5 plan steps, same language as the idea.\n\nIdea: ${idea}`,
      project || os.homedir(),
    );
    const parsed = parseJsonBlock(text || "");
    if (parsed && parsed.audience && Array.isArray(parsed.features) && Array.isArray(parsed.plan)) {
      return {
        audience: { who: String(parsed.audience.who || ""), pain: String(parsed.audience.pain || "") },
        features: parsed.features.slice(0, 8).map(String),
        plan: parsed.plan.slice(0, 8).map((s) => ({ title: String(s.title || ""), detail: String(s.detail || "") })),
        simulated: false,
      };
    }
  }
  const fa = config.language === "fa";
  return {
    audience: fa
      ? { who: "کاربرانی که دقیقاً همین نیاز را دارند و امروز با ابزارهای پراکنده کارشان را راه می‌اندازند", pain: "نبود یک راه ساده و یکپارچه برای انجام این کار" }
      : { who: "People who need exactly this today and currently stitch together scattered tools", pain: "No single, simple place to get it done" },
    features: fa
      ? ["تجربه‌ی اصلی ایده، ساده و سریع", "صفحه‌ی معرفی شیک و واضح", "فرم یا اکشن اصلی کاربر", "طراحی واکنش‌گرا برای موبایل", "بخش اعتمادساز: نمونه‌کار یا نظرات"]
      : ["The core experience, simple and fast", "A clear, beautiful landing page", "The one main user action, front and center", "Fully responsive on mobile", "A trust section — examples or testimonials"],
    plan: previewSteps(),
    simulated: true,
  };
}

// ---------- turn dispatch ----------
async function runTurn(prompt, opts = {}) {
  const project = currentProject;
  try {
    if (opts.kind === "executePlan" && opts.plan) {
      await executePlannedTurn(opts.plan);
      return;
    }
    // A pending plan + a new user message = a revision request.
    if (pendingPlan && pendingPlan.project === project && !opts.skipPlanGate) {
      const revisedTask = `${pendingPlan.task}\n\nUser revision: ${prompt}`;
      const { steps } = await proposePlan(revisedTask, project);
      pendingPlan = { id: crypto.randomUUID(), task: pendingPlan.task, steps, project };
      broadcast({ type: "plan_proposed", planId: pendingPlan.id, task: pendingPlan.task, steps });
      broadcast({ type: "turn_done" });
      return;
    }
    if (effectivePlanMode(project) && !opts.skipPlanGate) {
      const { steps } = await proposePlan(prompt, project);
      pendingPlan = { id: crypto.randomUUID(), task: prompt, steps, project };
      broadcast({ type: "plan_proposed", planId: pendingPlan.id, task: prompt, steps });
      broadcast({ type: "turn_done" });
      return;
    }
    let manifest = null;
    try { manifest = await takeSnapshot(project); } catch (e) { console.error("Ronin Code: snapshot failed:", cleanError(e)); }
    const auth = loadAuth();
    if (!keyList(auth[config.provider]).length) {
      await runPreviewTurn();
    } else {
      await runLiveTurn(prompt, project, manifest, { autoMode: effectiveAutoMode(project) });
    }
  } catch (e) {
    broadcast({ type: "turn_error", message: cleanError(e) || "Something went wrong during that turn. Please try again." });
  } finally {
    turnRunning = false;
  }
}

// ---------- named checkpoints ----------
function checkpointsBase(project) {
  return path.join(SNAPSHOTS_DIR, projectHash(project), "checkpoints");
}
function checkpointsMetaPath(project) {
  return path.join(SNAPSHOTS_DIR, projectHash(project), "checkpoints.json");
}
function listCheckpoints(project) {
  const list = readJsonFile(checkpointsMetaPath(project), []);
  return Array.isArray(list) ? list : [];
}
async function createCheckpoint(project, name) {
  const manifest = await takeSnapshot(project); // refreshes "latest"
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(checkpointsBase(project), id);
  const latest = path.join(SNAPSHOTS_DIR, projectHash(project), "latest");
  await fsp.mkdir(checkpointsBase(project), { recursive: true });
  await fsp.cp(latest, dir, { recursive: true });
  const meta = { id, name: name || new Date().toLocaleString(), ts: new Date().toISOString(), files: manifest.files.length };
  const list = listCheckpoints(project);
  list.unshift(meta);
  await fsp.writeFile(checkpointsMetaPath(project), JSON.stringify(list.slice(0, 50), null, 2));
  return meta;
}
async function restoreTree(project, sourceDir, manifest) {
  const keep = new Set(manifest.files.map((f) => f.path));
  const now = await walkProject(project);
  for (const f of now) {
    if (!keep.has(f.path)) await fsp.rm(path.join(project, f.path), { force: true });
  }
  for (const f of manifest.files) {
    const dest = path.join(project, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(sourceDir, f.path), dest);
  }
}

// ---------- unified diff ----------
function unifiedDiff(oldText, newText, relPath) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > 1500 || b.length > 1500) return null;
  // LCS table
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = []; // {type:' '|'-'|'+', line}
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: " ", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", line: a[i] }); i++; }
    else { ops.push({ t: "+", line: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: "-", line: a[i++] });
  while (j < b.length) ops.push({ t: "+", line: b[j++] });
  // Build hunks with 3 lines of context.
  const CTX = 3;
  const hunks = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].t === " ") { idx++; continue; }
    const start = Math.max(0, idx - CTX);
    let end = idx;
    let lastChange = idx;
    while (end < ops.length) {
      if (ops[end].t !== " ") lastChange = end;
      if (end - lastChange > CTX * 2 && ops[end].t === " ") break;
      end++;
    }
    end = Math.min(ops.length, lastChange + CTX + 1);
    const slice = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((o) => o.t !== "+").length + 1;
    const newStart = ops.slice(0, start).filter((o) => o.t !== "-").length + 1;
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) hunks.push(o.t + o.line);
    idx = end;
    if (hunks.length > 420) { hunks.push("…"); break; }
  }
  if (!hunks.length) return "";
  return `--- a/${relPath}\n+++ b/${relPath}\n${hunks.join("\n")}`;
}

// ---------- minimal ZIP writer (store/deflate, stdlib zlib) ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(entries) {
  // entries: [{ name, data: Buffer }]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(e.data);
    const compressed = zlib.deflateRawSync(e.data);
    const useDeflate = compressed.length < e.data.length;
    const payload = useDeflate ? compressed : e.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
async function projectZipBuffer(project) {
  const files = await walkProject(project);
  const entries = [];
  for (const f of files) {
    if (f.path.startsWith("dist/") || f.path.startsWith("dist\\")) continue;
    entries.push({ name: f.path, data: await fsp.readFile(path.join(project, f.path)) });
  }
  return buildZip(entries);
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === "/api/providers" && req.method === "GET") {
    return sendJson(res, 200, providersView());
  }

  if (route === "/api/status" && req.method === "GET") {
    const auth = loadAuth();
    const hasKey = Boolean(keyList(auth[config.provider]).length);
    return sendJson(res, 200, {
      mode: hasKey ? "live" : "preview",
      provider: config.provider,
      model: currentModel(),
      hasKey,
      project: currentProject,
      onboarded: config.onboarded,
      language: config.language,
      autoMode: effectiveAutoMode(),
      planMode: effectivePlanMode(),
      projectMode: projectMode(),
      envAccess: currentProject ? config.envAllowedProjects[path.resolve(currentProject)] === true : false,
      budgetCapUsd: config.budgetCapUsd,
      failover: config.failover,
    });
  }

  if (route === "/api/settings" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") return sendJson(res, 400, { error: "Invalid JSON body" });
    const prevProvider = config.provider;
    if (body.provider !== undefined) {
      if (!providerById(body.provider)) return sendJson(res, 400, { error: `Unknown provider: ${body.provider}` });
      config.provider = body.provider;
    }
    if (body.model !== undefined && typeof body.model === "string" && body.model.trim()) {
      config.model = body.model.trim();
    } else if (body.provider !== undefined && body.provider !== prevProvider) {
      config.model = providerById(config.provider).defaultModel;
    }
    if (body.baseUrl !== undefined) {
      if (body.baseUrl === "" || body.baseUrl === null) {
        config.baseUrl = null;
      } else if (typeof body.baseUrl === "string") {
        let parsed;
        try { parsed = new URL(body.baseUrl.trim()); } catch { return sendJson(res, 400, { error: "The endpoint URL is not a valid URL" }); }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
          return sendJson(res, 400, { error: "The endpoint URL must start with http:// or https://" });
        config.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
      }
    }
    if (body.apiKey !== undefined) {
      const auth = loadAuth();
      if (body.apiKey === "") delete auth[config.provider];
      else if (typeof body.apiKey === "string") auth[config.provider] = [body.apiKey];
      saveAuth(auth);
    }
    if (body.apiKeys !== undefined) {
      // Full replacement of the key list for a provider (router settings).
      const target = body.keysProvider && providerById(body.keysProvider) ? body.keysProvider : config.provider;
      if (Array.isArray(body.apiKeys)) {
        const list = body.apiKeys.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim());
        const auth = loadAuth();
        if (list.length) auth[target] = list; else delete auth[target];
        saveAuth(auth);
      }
    }
    if (body.onboarded !== undefined) config.onboarded = body.onboarded === true;
    if (body.language !== undefined && (body.language === "en" || body.language === "fa")) {
      config.language = body.language;
    }
    if (body.autoMode !== undefined) config.autoMode = body.autoMode === true;
    if (body.planMode !== undefined) config.planMode = body.planMode === true;
    if (body.projectMode !== undefined && currentProject) {
      const key = path.resolve(currentProject);
      if (body.projectMode === "auto" || body.projectMode === "plan") config.projectModes[key] = body.projectMode;
      else delete config.projectModes[key];
    }
    if (body.failover !== undefined) config.failover = body.failover === true;
    if (body.failoverOrder !== undefined && Array.isArray(body.failoverOrder)) {
      config.failoverOrder = body.failoverOrder.filter((id) => providerById(id) && id !== config.provider);
    }
    if (body.budgetCapUsd !== undefined) {
      config.budgetCapUsd =
        typeof body.budgetCapUsd === "number" && body.budgetCapUsd > 0 ? body.budgetCapUsd : null;
    }
    if (body.envAccess !== undefined && currentProject) {
      const key = path.resolve(currentProject);
      if (body.envAccess === true) config.envAllowedProjects[key] = true;
      else delete config.envAllowedProjects[key];
    }
    saveConfig();
    return sendJson(res, 200, { ok: true, provider: config.provider, model: currentModel(), providers: providersView() });
  }

  if (route === "/api/settings/test" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const providerId = body.provider && providerById(body.provider) ? body.provider : config.provider;
    const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : keyList(loadAuth()[providerId])[0];
    if (!apiKey) return sendJson(res, 200, { ok: false, message: "No API key is saved for this provider yet." });
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : config.baseUrl;
    return sendJson(res, 200, await testProviderKey(providerId, apiKey, baseUrl));
  }

  if (route === "/api/projects/select" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.path !== "string" || !body.path) return sendJson(res, 400, { error: "A project path is required" });
    const p = path.resolve(body.path);
    let st;
    try { st = await fsp.stat(p); } catch { return sendJson(res, 400, { error: "That folder does not exist" }); }
    if (!st.isDirectory()) return sendJson(res, 400, { error: "That path is not a folder" });
    currentProject = p;
    saveConfig();
    return sendJson(res, 200, { path: currentProject });
  }

  if (route === "/api/starters" && req.method === "GET") {
    const manifestPath = path.join(HOST_DIR, "starters", "starters.json");
    const doc = readJsonFile(manifestPath, { starters: [] });
    const list = (Array.isArray(doc.starters) ? doc.starters : []).map((s) => ({
      id: s.id,
      name: s.name || { en: s.id, fa: s.id },
      tagline: s.tagline || { en: "", fa: "" },
      accent: s.accent || "#e5484d",
    }));
    list.unshift({
      id: "classic",
      name: { en: "Classic Starter", fa: "شروع کلاسیک" },
      tagline: { en: "A tiny page to make your own", fa: "یک صفحه‌ی کوچک برای شروع" },
      accent: "#e8b33c",
    });
    return sendJson(res, 200, list);
  }

  if (route === "/api/projects/starter" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const base = process.env.RONIN_PROJECTS_DIR
      ? path.resolve(process.env.RONIN_PROJECTS_DIR)
      : path.join(os.homedir(), "ronin-projects");
    const starterId = typeof body.starterId === "string" ? body.starterId : "classic";
    if (starterId !== "classic") {
      const manifestPath = path.join(HOST_DIR, "starters", "starters.json");
      const doc = readJsonFile(manifestPath, { starters: [] });
      const entry = (Array.isArray(doc.starters) ? doc.starters : []).find((s) => s.id === starterId);
      if (!entry) return sendJson(res, 404, { error: "Unknown starter", code: "not_found" });
      const srcDir = path.join(HOST_DIR, "starters", entry.dir || entry.id);
      const dir = path.join(base, `ronin-${entry.id}`);
      await fsp.mkdir(dir, { recursive: true });
      for (const name of await fsp.readdir(srcDir)) {
        const src = path.join(srcDir, name);
        const dest = path.join(dir, name);
        if ((await fsp.stat(src)).isFile() && !fs.existsSync(dest)) await fsp.copyFile(src, dest);
      }
      currentProject = dir;
      saveConfig();
      return sendJson(res, 200, { path: dir });
    }
    const dir = path.join(base, "ronin-starter");
    await fsp.mkdir(dir, { recursive: true });
    const files = { "index.html": STARTER_HTML, "styles.css": STARTER_CSS, "app.js": STARTER_JS };
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(dir, name);
      if (!fs.existsSync(fp)) await fsp.writeFile(fp, content);
    }
    currentProject = dir;
    saveConfig();
    return sendJson(res, 200, { path: dir });
  }

  if (route === "/api/undo" && req.method === "POST") {
    if (!currentProject) return sendJson(res, 400, { error: "No project is open, so there is nothing to undo", code: "no_project" });
    const manifest = await readManifest(currentProject);
    const latest = path.join(SNAPSHOTS_DIR, projectHash(currentProject), "latest");
    if (!manifest || !fs.existsSync(latest))
      return sendJson(res, 400, { error: "No snapshot is available for this project yet. Run a turn first, then undo becomes available.", code: "no_snapshot" });
    await restoreTree(currentProject, latest, manifest);
    return sendJson(res, 200, { ok: true, files: manifest.files.map((f) => f.path) });
  }

  if (route === "/api/checkpoints" && req.method === "GET") {
    if (!currentProject) return sendJson(res, 200, []);
    return sendJson(res, 200, listCheckpoints(currentProject));
  }

  if (route === "/api/checkpoints" && req.method === "POST") {
    if (!currentProject) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const body = await readBody(req).catch(() => ({}));
    const meta = await createCheckpoint(currentProject, typeof body.name === "string" ? body.name.slice(0, 80) : "");
    return sendJson(res, 200, meta);
  }

  if (route === "/api/checkpoints/restore" && req.method === "POST") {
    if (!currentProject) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const body = await readBody(req).catch(() => ({}));
    const meta = listCheckpoints(currentProject).find((c) => c.id === body.id);
    if (!meta) return sendJson(res, 404, { error: "Checkpoint not found", code: "not_found" });
    const dir = path.join(checkpointsBase(currentProject), meta.id);
    // Rebuild a manifest from the checkpoint's own files.
    const savedProject = currentProject;
    const files = await walkProject(dir);
    const manifest = { project: savedProject, timestamp: meta.ts, files: files.map((f) => ({ ...f })) };
    await restoreTree(currentProject, dir, manifest);
    return sendJson(res, 200, { ok: true, name: meta.name });
  }

  if (route === "/api/diff" && req.method === "GET") {
    if (!lastTurnDiff || lastTurnDiff.project !== currentProject || !lastTurnDiff.manifest) {
      return sendJson(res, 200, { files: [] });
    }
    const latest = path.join(SNAPSHOTS_DIR, projectHash(currentProject), "latest");
    const out = [];
    for (const c of lastTurnDiff.changes.slice(0, 50)) {
      const beforePath = path.join(latest, c.path);
      const afterPath = path.join(currentProject, c.path);
      const before = fs.existsSync(beforePath) ? await fsp.readFile(beforePath, "utf8").catch(() => "") : "";
      const after = fs.existsSync(afterPath) ? await fsp.readFile(afterPath, "utf8").catch(() => "") : "";
      const binary = before.includes("\0") || after.includes("\0");
      out.push({
        path: c.path,
        action: c.action,
        diff: binary ? null : unifiedDiff(before, after, c.path),
      });
    }
    return sendJson(res, 200, { files: out });
  }

  if (route === "/api/usage" && req.method === "GET") {
    const usage = loadUsage();
    return sendJson(res, 200, {
      totals: sessionTotals(),
      recent: usage.turns.slice(-20).reverse(),
      rtk: {
        calls: usage.rtk.calls || 0,
        savedChars: Math.max(0, (usage.rtk.originalChars || 0) - (usage.rtk.compressedChars || 0)),
      },
      budgetCapUsd: config.budgetCapUsd,
    });
  }

  if (route.startsWith("/api/approvals/") && req.method === "POST") {
    const id = decodeURIComponent(route.slice("/api/approvals/".length));
    const body = await readBody(req).catch(() => ({}));
    const ok = resolveApproval(id, body.approved === true);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  if (route === "/api/plan/approve" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (!pendingPlan || body.planId !== pendingPlan.id)
      return sendJson(res, 404, { error: "That plan is no longer pending", code: "not_found" });
    if (turnRunning) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    const plan = pendingPlan;
    pendingPlan = null;
    turnRunning = true;
    sendJson(res, 200, { ok: true });
    runTurn("", { kind: "executePlan", plan }).catch((e) => {
      console.error("Ronin Code: planned turn failed:", cleanError(e));
      turnRunning = false;
    });
    return;
  }

  if (route === "/api/plan/reject" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (pendingPlan && (!body.planId || body.planId === pendingPlan.id)) {
      broadcast({ type: "plan_cleared", planId: pendingPlan.id });
      pendingPlan = null;
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/ideas/mature" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.idea !== "string" || !body.idea.trim())
      return sendJson(res, 400, { error: "Describe your idea in a sentence first", code: "prompt_required" });
    const result = await matureIdea(body.idea.trim(), currentProject);
    return sendJson(res, 200, result);
  }

  if (route === "/api/ideas/build" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.idea !== "string" || !body.idea.trim())
      return sendJson(res, 400, { error: "An idea is required", code: "prompt_required" });
    if (turnRunning) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    const base = process.env.RONIN_PROJECTS_DIR
      ? path.resolve(process.env.RONIN_PROJECTS_DIR)
      : path.join(os.homedir(), "ronin-projects");
    const slug =
      body.idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "idea";
    const dir = path.join(base, `${slug}-${crypto.randomUUID().slice(0, 6)}`);
    await fsp.mkdir(dir, { recursive: true });
    currentProject = dir;
    saveConfig();
    const m = body.mature || {};
    const task =
      `Build this product: ${body.idea.trim()}\n` +
      (m.audience ? `\nTarget audience: ${m.audience.who || ""} — their pain: ${m.audience.pain || ""}` : "") +
      (Array.isArray(m.features) && m.features.length ? `\nKey features:\n${m.features.map((f) => `- ${f}`).join("\n")}` : "") +
      (Array.isArray(m.plan) && m.plan.length ? `\nBuild plan:\n${m.plan.map((s, i) => `${i + 1}. ${s.title} — ${s.detail || ""}`).join("\n")}` : "") +
      `\nStart with a complete, polished index.html + styles.css + app.js static site in this folder.`;
    turnRunning = true;
    sendJson(res, 200, { ok: true, path: dir });
    // The idea view already showed this plan — execution respects the
    // approval gate / Auto mode inside the turn itself.
    runTurn(task, { skipPlanGate: true }).catch((e) => {
      console.error("Ronin Code: idea build failed:", cleanError(e));
      turnRunning = false;
    });
    return;
  }

  if (route === "/api/projects/export" && req.method === "GET") {
    if (!currentProject) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const zip = await projectZipBuffer(currentProject);
    const name = `${path.basename(currentProject)}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": `attachment; filename="${name}"`,
    });
    return res.end(zip);
  }

  if (route === "/api/projects/export-dist" && req.method === "POST") {
    if (!currentProject) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const dist = path.join(currentProject, "dist");
    const files = await walkProject(currentProject);
    let copied = 0;
    for (const f of files) {
      if (f.path.startsWith("dist/") || f.path.startsWith("dist\\")) continue;
      const dest = path.join(dist, f.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(currentProject, f.path), dest);
      copied++;
    }
    return sendJson(res, 200, { ok: true, path: dist, files: copied });
  }

  if (route === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseClients.add(res);
    const hello = { id: ++eventSeq, type: "hello", apiVersion: 1 };
    res.write(`id: ${hello.id}\ndata: ${JSON.stringify(hello)}\n\n`);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (route === "/api/turn" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim())
      return sendJson(res, 400, { error: "A prompt is required", code: "prompt_required" });
    if (!currentProject) return sendJson(res, 400, { error: "No project is open. Open or create a project first.", code: "no_project" });
    if (turnRunning) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    if (config.budgetCapUsd && sessionTotals().costUsd >= config.budgetCapUsd)
      return sendJson(res, 402, { error: "Your budget cap has been reached. Raise it in Settings to keep going.", code: "budget_exceeded" });
    turnRunning = true;
    const turnId = crypto.randomUUID();
    sendJson(res, 200, { ok: true, turnId });
    runTurn(body.prompt.trim()).catch((e) => {
      console.error("Ronin Code: turn failed:", cleanError(e));
      turnRunning = false;
    });
    return;
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/ronin-config.js") {
    return sendText(res, 200, `window.__RONIN_TOKEN__=${JSON.stringify(TOKEN)};\n`, "text/javascript; charset=utf-8");
  }
  if (!fs.existsSync(GUI_DIST)) {
    return sendText(res, 200, "Ronin Code is running, but the interface hasn't been built yet. Build the GUI, then refresh this page.");
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  let target = safeJoin(GUI_DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(GUI_DIST, "index.html"); // SPA fallback
  }
  try {
    let data = await fsp.readFile(target);
    if (target.endsWith("index.html")) {
      data = Buffer.from(data.toString("utf8").split("__RONIN_TOKEN__").join(TOKEN), "utf8");
    }
    res.writeHead(200, { "Content-Type": mimeFor(target), "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function servePreview(req, res, url) {
  if (!currentProject) {
    // Dark, on-brand placeholder — never a stark white pane.
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ronin Code</title><style>
      html,body{height:100%;margin:0}body{background:#0b0c10;color:#626a77;display:grid;place-items:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif}
      .c{text-align:center}.r{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;
      border:2px solid rgba(229,72,77,.5);border-top-color:transparent;transform:rotate(-38deg)}
      p{margin:0;font-size:13px;letter-spacing:.02em}</style></head>
      <body><div class="c"><div class="r"></div><p>Your project preview will appear here</p></div></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    return res.end(html);
  }
  let rel = decodeURIComponent(url.pathname.slice("/preview".length)) || "/";
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";
  const target = safeJoin(path.resolve(currentProject), rel);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    if (rel.endsWith("index.html")) {
      // Project is open but has no page yet — keep the branded placeholder
      // instead of a bare 404 while the agent creates the first files.
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ronin Code</title><style>
        html,body{height:100%;margin:0}body{background:#0b0c10;color:#626a77;display:grid;place-items:center;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif}
        .c{text-align:center}.r{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;
        border:2px solid rgba(229,72,77,.5);border-top-color:transparent;transform:rotate(-38deg)}
        p{margin:0;font-size:13px;letter-spacing:.02em}</style></head>
        <body><div class="c"><div class="r"></div><p>Your creation will appear here</p></div></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }
    return sendText(res, 404, "Not found");
  }
  const data = await fsp.readFile(target);
  res.writeHead(200, { "Content-Type": mimeFor(target), "Content-Length": data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return sendJson(res, 403, { error: "Forbidden host" });
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, name: "Ronin Code", version: VERSION });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOk(req, url)) return sendJson(res, 401, { error: "Missing or invalid Ronin Code token" });
      return await handleApi(req, res, url);
    }
    if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
      return await servePreview(req, res, url);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(req, res, url);
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("Ronin Code: request error:", cleanError(e));
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Please try again." });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Ronin Code host listening on http://127.0.0.1:${PORT}`);
  console.log(`Ronin Code data directory: ${RONIN_HOME}`);
  console.log(`Ronin Code mode: ${loadAuth()[config.provider] ? "live" : "preview"} (${config.provider} / ${currentModel()})`);
});
