// Ronin Code — local host service.
// Plain ESM Node (>=20), node:http + stdlib only. The embedded agent engine
// is loaded lazily, only for live turns (see ENGINE.md for the exact SDK API).

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
  };
}
function loadAuth() {
  const a = readJsonFile(AUTH_PATH, {});
  return a && typeof a === "object" && !Array.isArray(a) ? a : {};
}
function maskedKey(key) {
  if (!key || typeof key !== "string") return null;
  return "••••" + key.slice(-4);
}
function providersView() {
  const auth = loadAuth();
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    defaultModel: p.defaultModel,
    hasKey: Boolean(auth[p.id]),
    maskedKey: maskedKey(auth[p.id]),
    ...(p.id === "custom" ? { baseUrl: config.baseUrl || "" } : {}),
  }));
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
  });
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

async function runLiveTurn(prompt, providerId, modelId, apiKey, project, manifest) {
  // Embedded engine — actual installed SDK API (v1.3.0, see ENGINE.md):
  //   ModelRuntime.create({ authPath, modelsPath })
  //   modelRuntime.setRuntimeApiKey(providerId, apiKey)
  //   modelRuntime.getModel(providerId, modelId)
  //   SessionManager.create(cwd, sessionDir)
  //   SettingsManager.inMemory(...)
  //   createAgentSession({ cwd, agentDir, modelRuntime, model, sessionManager, settingsManager })
  //   session.subscribe(fn); await session.prompt(text);
  //   session.getLastAssistantText(); session.dispose();
  const engine = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = engine;

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

  const { session } = await createAgentSession({
    cwd: project,
    agentDir: ENGINE_DIR,
    modelRuntime,
    model,
    sessionManager,
    settingsManager,
  });

  const toolActivities = new Map(); // toolCallId -> {activityId, kind}
  const trackedFiles = new Map(); // relPath -> action
  let thinkingId = null;
  let thinkingKind = "thinking";
  let toolCount = 0;
  let editedDone = false;
  let assistantText = "";

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
          assistantText += ame.delta;
          broadcast({ type: "assistant_delta", text: ame.delta });
        }
      } else if (event.type === "tool_execution_start") {
        endThinking();
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
      // Prefer the diff; fix actions for files the diff marked "created" that were edits of new files.
      const seen = new Set(changes.map((c) => c.path));
      for (const [p, action] of trackedFiles) if (!seen.has(p)) changes.push({ path: p, action });
    }
    broadcast({ type: "assistant_message", text: finalText || "Done." });
    broadcast({ type: "changes", files: changes });
    broadcast({ type: "turn_done" });
  } finally {
    try { unsubscribe(); } catch {}
    try { session.dispose(); } catch {}
  }
}

async function runTurn(prompt) {
  const project = currentProject;
  let manifest = null;
  try { manifest = await takeSnapshot(project); } catch (e) { console.error("Ronin Code: snapshot failed:", cleanError(e)); }

  const auth = loadAuth();
  const apiKey = auth[config.provider];
  try {
    if (!apiKey) {
      await runPreviewTurn();
    } else {
      await runLiveTurn(prompt, config.provider, currentModel(), apiKey, project, manifest);
    }
  } catch (e) {
    broadcast({ type: "turn_error", message: cleanError(e) || "Something went wrong during that turn. Please try again." });
  } finally {
    turnRunning = false;
  }
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === "/api/providers" && req.method === "GET") {
    return sendJson(res, 200, providersView());
  }

  if (route === "/api/status" && req.method === "GET") {
    const auth = loadAuth();
    const hasKey = Boolean(auth[config.provider]);
    return sendJson(res, 200, {
      mode: hasKey ? "live" : "preview",
      provider: config.provider,
      model: currentModel(),
      hasKey,
      project: currentProject,
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
      else if (typeof body.apiKey === "string") auth[config.provider] = body.apiKey;
      writeJsonFile0600(AUTH_PATH, auth);
    }
    saveConfig();
    return sendJson(res, 200, { ok: true, provider: config.provider, model: currentModel(), providers: providersView() });
  }

  if (route === "/api/settings/test" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const providerId = body.provider && providerById(body.provider) ? body.provider : config.provider;
    const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : loadAuth()[providerId];
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

  if (route === "/api/projects/starter" && req.method === "POST") {
    const base = process.env.RONIN_PROJECTS_DIR
      ? path.resolve(process.env.RONIN_PROJECTS_DIR)
      : path.join(os.homedir(), "ronin-projects");
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
    if (!currentProject) return sendJson(res, 400, { error: "No project is open, so there is nothing to undo" });
    const manifest = await readManifest(currentProject);
    const latest = path.join(SNAPSHOTS_DIR, projectHash(currentProject), "latest");
    if (!manifest || !fs.existsSync(latest))
      return sendJson(res, 400, { error: "No snapshot is available for this project yet. Run a turn first, then undo becomes available." });
    // Delete project files that are not in the snapshot.
    const keep = new Set(manifest.files.map((f) => f.path));
    const now = await walkProject(currentProject);
    for (const f of now) {
      if (!keep.has(f.path)) await fsp.rm(path.join(currentProject, f.path), { force: true });
    }
    // Copy the snapshot back.
    for (const f of manifest.files) {
      const dest = path.join(currentProject, f.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(latest, f.path), dest);
    }
    return sendJson(res, 200, { ok: true, files: manifest.files.map((f) => f.path) });
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
      return sendJson(res, 400, { error: "A prompt is required" });
    if (!currentProject) return sendJson(res, 400, { error: "No project is open. Open or create a project first." });
    if (turnRunning) return sendJson(res, 409, { error: "A turn is already running" });
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
