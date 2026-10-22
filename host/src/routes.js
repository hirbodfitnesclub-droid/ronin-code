import { log } from "./log.js";
// Ronin Code — local host service.
// The versioned local API the GUI talks to. Every route the GUI uses
// lives here; transport concerns live in http.js / http-server.js.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { HOST_DIR, SNAPSHOTS_DIR } from "./paths.js";
import { readJsonFile, cleanError } from "./util.js";
import { broadcast, addSseClient, removeSseClient, helloFrame } from "./sse.js";
import {
  config, providerById, getProject, setProject, saveConfig,
  effectiveAutoMode, effectivePlanMode, projectMode,
  loadAuth, saveAuth, keyList, currentModel, providersView,
} from "./config.js";
import { loadUsage, sessionTotals } from "./usage.js";
import {
  projectHash, walkProject, takeSnapshot, readManifest, diffAgainstManifest,
  listCheckpoints, createCheckpoint, restoreTree, checkpointsBase,
} from "./snapshots.js";
import { unifiedDiff } from "./diff.js";
import { projectZipBuffer } from "./publish.js";
import { STARTER_HTML, STARTER_CSS, STARTER_JS } from "./starters.js";
import { testProviderKey } from "./router.js";
import { resolveApproval } from "./guard.js";
import { getLastTurnDiff } from "./engine.js";
import {
  runTurn, matureIdea, isTurnRunning, setTurnRunning, getPendingPlan, setPendingPlan,
} from "./turns.js";
import { sendJson, readBody } from "./http.js";

export async function handleApi(req, res, url) {
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
      project: getProject(),
      onboarded: config.onboarded,
      language: config.language,
      autoMode: effectiveAutoMode(),
      planMode: effectivePlanMode(),
      projectMode: projectMode(),
      envAccess: getProject() ? config.envAllowedProjects[path.resolve(getProject())] === true : false,
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
      else if (typeof body.apiKey === "string") {
        // Replace the first key slot in place (multi-key lists survive).
        const list = keyList(auth[config.provider]);
        if (list.length) {
          list[0] = body.apiKey;
          auth[config.provider] = list;
        } else {
          auth[config.provider] = [body.apiKey];
        }
      }
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
    if (body.addKeys !== undefined && Array.isArray(body.addKeys)) {
      const target = body.keysProvider && providerById(body.keysProvider) ? body.keysProvider : config.provider;
      const auth = loadAuth();
      const list = keyList(auth[target]);
      for (const k of body.addKeys) {
        if (typeof k === "string" && k.trim() && !list.includes(k.trim())) list.push(k.trim());
      }
      if (list.length) auth[target] = list;
      saveAuth(auth);
    }
    if (body.removeKeyIndex !== undefined && typeof body.removeKeyIndex === "number") {
      const target = body.keysProvider && providerById(body.keysProvider) ? body.keysProvider : config.provider;
      const auth = loadAuth();
      const list = keyList(auth[target]);
      if (body.removeKeyIndex >= 0 && body.removeKeyIndex < list.length) {
        list.splice(body.removeKeyIndex, 1);
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
    if (body.projectMode !== undefined && getProject()) {
      const key = path.resolve(getProject());
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
    if (body.envAccess !== undefined && getProject()) {
      const key = path.resolve(getProject());
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
    setProject(p);
    saveConfig();
    return sendJson(res, 200, { path: getProject() });
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
      setProject(dir);
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
    setProject(dir);
    saveConfig();
    return sendJson(res, 200, { path: dir });
  }

  if (route === "/api/client-error" && req.method === "POST") {
    // Best-effort GUI crash reports (React ErrorBoundary). Metadata only;
    // message/stack are length-capped before they reach the log.
    const body = await readBody(req).catch(() => null);
    log.error("client_error", {
      message: String(body?.message ?? "unknown").slice(0, 500),
      stack: body?.stack ? String(body.stack).slice(0, 2000) : undefined,
    });
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/undo" && req.method === "POST") {
    if (!getProject()) return sendJson(res, 400, { error: "No project is open, so there is nothing to undo", code: "no_project" });
    const manifest = await readManifest(getProject());
    const latest = path.join(SNAPSHOTS_DIR, projectHash(getProject()), "latest");
    if (!manifest || !fs.existsSync(latest))
      return sendJson(res, 400, { error: "No snapshot is available for this project yet. Run a turn first, then undo becomes available.", code: "no_snapshot" });
    await restoreTree(getProject(), latest, manifest);
    return sendJson(res, 200, { ok: true, files: manifest.files.map((f) => f.path) });
  }

  if (route === "/api/checkpoints" && req.method === "GET") {
    if (!getProject()) return sendJson(res, 200, []);
    return sendJson(res, 200, listCheckpoints(getProject()));
  }

  if (route === "/api/checkpoints" && req.method === "POST") {
    if (!getProject()) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const body = await readBody(req).catch(() => ({}));
    const meta = await createCheckpoint(getProject(), typeof body.name === "string" ? body.name.slice(0, 80) : "");
    return sendJson(res, 200, meta);
  }

  if (route === "/api/checkpoints/restore" && req.method === "POST") {
    if (!getProject()) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const body = await readBody(req).catch(() => ({}));
    const meta = listCheckpoints(getProject()).find((c) => c.id === body.id);
    if (!meta) return sendJson(res, 404, { error: "Checkpoint not found", code: "not_found" });
    const dir = path.join(checkpointsBase(getProject()), meta.id);
    // Rebuild a manifest from the checkpoint's own files.
    const savedProject = getProject();
    const files = await walkProject(dir);
    const manifest = { project: savedProject, timestamp: meta.ts, files: files.map((f) => ({ ...f })) };
    await restoreTree(getProject(), dir, manifest);
    return sendJson(res, 200, { ok: true, name: meta.name });
  }

  if (route === "/api/diff" && req.method === "GET") {
    if (!lastTurnDiff || lastTurnDiff.project !== getProject() || !lastTurnDiff.manifest) {
      return sendJson(res, 200, { files: [] });
    }
    const latest = path.join(SNAPSHOTS_DIR, projectHash(getProject()), "latest");
    const out = [];
    for (const c of lastTurnDiff.changes.slice(0, 50)) {
      const beforePath = path.join(latest, c.path);
      const afterPath = path.join(getProject(), c.path);
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
    if (!getPendingPlan() || body.planId !== getPendingPlan().id)
      return sendJson(res, 404, { error: "That plan is no longer pending", code: "not_found" });
    if (isTurnRunning()) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    const plan = getPendingPlan();
    setPendingPlan(null);
    setTurnRunning(true);
    sendJson(res, 200, { ok: true });
    runTurn("", { kind: "executePlan", plan }).catch((e) => {
      log.error("planned_turn_failed", { error: cleanError(e) });
      setTurnRunning(false);
    });
    return;
  }

  if (route === "/api/plan/reject" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (getPendingPlan() && (!body.planId || body.planId === getPendingPlan().id)) {
      broadcast({ type: "plan_cleared", planId: getPendingPlan().id });
      setPendingPlan(null);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/ideas/mature" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.idea !== "string" || !body.idea.trim())
      return sendJson(res, 400, { error: "Describe your idea in a sentence first", code: "prompt_required" });
    const result = await matureIdea(body.idea.trim(), getProject());
    return sendJson(res, 200, result);
  }

  if (route === "/api/ideas/build" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.idea !== "string" || !body.idea.trim())
      return sendJson(res, 400, { error: "An idea is required", code: "prompt_required" });
    if (isTurnRunning()) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    const base = process.env.RONIN_PROJECTS_DIR
      ? path.resolve(process.env.RONIN_PROJECTS_DIR)
      : path.join(os.homedir(), "ronin-projects");
    const slug =
      body.idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "idea";
    const dir = path.join(base, `${slug}-${crypto.randomUUID().slice(0, 6)}`);
    await fsp.mkdir(dir, { recursive: true });
    setProject(dir);
    saveConfig();
    const m = body.mature || {};
    const task =
      `Build this product: ${body.idea.trim()}\n` +
      (m.audience ? `\nTarget audience: ${m.audience.who || ""} — their pain: ${m.audience.pain || ""}` : "") +
      (Array.isArray(m.features) && m.features.length ? `\nKey features:\n${m.features.map((f) => `- ${f}`).join("\n")}` : "") +
      (Array.isArray(m.plan) && m.plan.length ? `\nBuild plan:\n${m.plan.map((s, i) => `${i + 1}. ${s.title} — ${s.detail || ""}`).join("\n")}` : "") +
      `\nStart with a complete, polished index.html + styles.css + app.js static site in this folder.`;
    setTurnRunning(true);
    sendJson(res, 200, { ok: true, path: dir });
    // The idea view already showed this plan — execution respects the
    // approval gate / Auto mode inside the turn itself.
    runTurn(task, { skipPlanGate: true }).catch((e) => {
      log.error("idea_build_failed", { error: cleanError(e) });
      setTurnRunning(false);
    });
    return;
  }

  if (route === "/api/projects/export" && req.method === "GET") {
    if (!getProject()) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const zip = await projectZipBuffer(getProject());
    const name = `${path.basename(getProject())}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": `attachment; filename="${name}"`,
    });
    return res.end(zip);
  }

  if (route === "/api/projects/export-dist" && req.method === "POST") {
    if (!getProject()) return sendJson(res, 400, { error: "No project is open", code: "no_project" });
    const dist = path.join(getProject(), "dist");
    const files = await walkProject(getProject());
    let copied = 0;
    for (const f of files) {
      if (f.path.startsWith("dist/") || f.path.startsWith("dist\\")) continue;
      const dest = path.join(dist, f.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(getProject(), f.path), dest);
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
    addSseClient(res);
    res.write(helloFrame());
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); removeSseClient(res); });
    return;
  }

  if (route === "/api/turn" && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim())
      return sendJson(res, 400, { error: "A prompt is required", code: "prompt_required" });
    if (!getProject()) return sendJson(res, 400, { error: "No project is open. Open or create a project first.", code: "no_project" });
    if (isTurnRunning()) return sendJson(res, 409, { error: "A turn is already running", code: "turn_running" });
    if (config.budgetCapUsd && sessionTotals().costUsd >= config.budgetCapUsd)
      return sendJson(res, 402, { error: "Your budget cap has been reached. Raise it in Settings to keep going.", code: "budget_exceeded" });
    setTurnRunning(true);
    const turnId = crypto.randomUUID();
    sendJson(res, 200, { ok: true, turnId });
    runTurn(body.prompt.trim()).catch((e) => {
      log.error("turn_request_failed", { error: cleanError(e) });
      setTurnRunning(false);
    });
    return;
  }

  return sendJson(res, 404, { error: "Not found" });
}
