// Ronin Code — local host service.
// Engine session lifecycle (embedded SDK — see ENGINE.md): activity
// event mapping, one live attempt per provider+key, the failover loop,
// preview turns, and the tools-free JSON prompt used by plan/idea.

import { log } from "./log.js";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR, SESSIONS_DIR } from "./paths.js";
import { config, loadAuth } from "./config.js";
import { sleep, cleanError } from "./util.js";
import { broadcast } from "./sse.js";
import { makeGuardExtension, collectSecretValues } from "./guard.js";
import { buildAttempts, isFailoverError } from "./router.js";
import { finalizeTurnUsage } from "./cost.js";
import { diffAgainstManifest } from "./snapshots.js";

export let activitySeq = 0;

export const nextActivityId = () => `act-${++activitySeq}`;

export function emitActivity(kind, ms) {
  const activityId = nextActivityId();
  broadcast({ type: "activity_start", activityId, kind });
  return { activityId, kind, async end() { broadcast({ type: "activity_end", activityId, kind }); } };
}

export async function runActivity(kind, ms) {
  const a = emitActivity(kind, ms);
  await sleep(ms);
  await a.end();
}

export async function runPreviewTurn() {
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

export const TOOL_KIND = {
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

export async function runLiveAttempt({ prompt, providerId, modelId, apiKey, project, manifest, autoMode, onProgress, state }) {
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
  let providerError = null;
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
        // The engine reports provider failures as an assistant message with
        // stopReason "error" instead of throwing — surface it as a throw so
        // the router can fail over to the next key/provider.
        if (event.message && event.message.stopReason === "error") {
          providerError = event.message.errorMessage || "The provider returned an error.";
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
    if (providerError) throw new Error(providerError);

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

export let lastTurnDiff = null; // { project, manifest, changes } for the diff view

export async function runLiveTurn(prompt, project, manifest, { autoMode, onProgress } = {}) {
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
      log.warn("provider_failed_failover", { provider: a.providerId, error: msg });
    }
  }
  if (lastError) throw lastError;
}

// ---------- plan mode ----------

export function parseJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

/** A tools-free engine call that must answer with JSON. Used by plan + idea flows. */

export async function runJsonPrompt(promptText, project) {
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

export function getLastTurnDiff() { return lastTurnDiff; }
