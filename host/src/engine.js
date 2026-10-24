// Ronin Code — local host service.
// Engine session lifecycle (embedded SDK — see ENGINE.md): activity
// event mapping, one live attempt per provider+key, the failover loop,
// preview turns, and the tools-free JSON prompt used by plan/idea.

import { log } from "./log.js";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR, SESSIONS_DIR } from "./paths.js";
import { config, loadAuth, currentModel } from "./config.js";
import { sleep, cleanError } from "./util.js";
import { broadcast } from "./sse.js";
import { makeGuardExtension, collectSecretValues } from "./guard.js";
import { buildAttempts, isFailoverError, buildSubscriptionAttempt, classifyProxyError, SUBSCRIPTION_PROVIDER_ID } from "./router.js";
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

export async function runLiveAttempt({ prompt, providerId, modelId, apiKey, project, manifest, autoMode, onProgress, state, baseUrl, modelMeta, thinkingLevel, thinkingLevelMap, fast }) {
  // Embedded engine — actual installed SDK API (v1.3.0, see ENGINE.md).
  const engine = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader } = engine;

  if (providerId === "custom" || providerId === SUBSCRIPTION_PROVIDER_ID) {
    // Register an OpenAI-compatible endpoint with the engine: the user's
    // own endpoint ("custom") or the Ronin subscription proxy. The key
    // itself never lands in models.json — it is referenced through an
    // environment variable that only this host process sets.
    const isSubscription = providerId === SUBSCRIPTION_PROVIDER_ID;
    const effectiveBaseUrl = isSubscription ? baseUrl : config.baseUrl;
    if (!effectiveBaseUrl) throw new Error("No endpoint URL is configured for the custom provider.");
    const envName = isSubscription ? "RONIN_SUBSCRIPTION_KEY" : "RONIN_CUSTOM_KEY";
    process.env[envName] = apiKey;
    const modelEntry = isSubscription
      ? {
          id: modelId,
          name: modelMeta?.name || modelId,
          reasoning: true,
          // The proxy speaks text/image inputs; other catalog modalities
          // are not engine input types.
          input: (modelMeta?.inputs || ["text"]).filter((i) => i === "text" || i === "image"),
          contextWindow: modelMeta?.context || 200000,
          maxTokens: 32768,
          // Metered in tokens server-side; zero local price so the
          // engine never invents a USD cost for subscription usage.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsReasoningEffort: true },
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          ...(fast ? { headers: { "x-ronin-fast": "1" } } : {}),
        }
      : { id: modelId, name: modelId, contextWindow: 1048576, maxTokens: 32768 };
    const modelsDoc = {
      providers: {
        [providerId]: {
          baseUrl: effectiveBaseUrl,
          api: "openai-completions",
          apiKey: `$${envName}`,
          models: [modelEntry],
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
    // Only subscription attempts pass a thinking level (it becomes the
    // proxy's reasoning_effort); legacy BYOK sessions keep the engine
    // default exactly as before.
    ...(thinkingLevel ? { thinkingLevel } : {}),
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

/**
 * One subscription turn. Single route (no BYOK failover chain), with
 * failures mapped to stable turn_error codes by the caller (design
 * §6.4). The transport is per-attempt (attempt.transport): 'relay'
 * (Ronin server /v1) or 'direct' (host → provider with the delegated
 * key); streaming and mapping are shared, with ONE difference —
 * error semantics at the endpoint:
 *  402 → 'insufficient_credit' (existing credit banner) on both;
 *  relay 403 `account_suspended` → 'subscription_locked' (existing
 *  locked banner — never 'model_disabled');
 *  relay key-shaped failures (401 / `provider_key_invalid`) → ONE
 *  credential re-fetch (§5.2c) and, when it yields a different key
 *  and nothing user-visible has streamed yet, ONE retry — the
 *  stale-key self-heal of §10 row 15. After that, the v1 session
 *  path applies: one forced revalidate, then 'login_required' if
 *  the session was cleared;
 *  DIRECT provider 401 (a frozen delegated key returns 401 at the
 *  provider — verified live in Phase 2) → the SAME heal attempt,
 *  then 'subscription_locked', never the session/login path: the
 *  session is fine, the key is not spendable.
 *  Network failure to either endpoint classifies as neither and
 *  surfaces as the generic turn error, leaving the session usable
 *  for the next turn (same recovery as the relay hang/close case).
 */
export async function runSubscriptionLive(prompt, project, manifest, { authManager, modelId, effort, fast, autoMode } = {}) {
  let retriedAfterRefetch = false;
  for (;;) {
    const attempt = await buildSubscriptionAttempt(authManager, { modelId, effort, fast });
    const state = { visible: false };
    try {
      const r = await runLiveAttempt({ prompt, ...attempt, project, manifest, autoMode, state });
      // apiKey is a session token (shared) or the delegated key
      // (per-user) — either way never feed it to per-key stats.
      finalizeTurnUsage({ providerId: attempt.providerId, modelId: attempt.modelId, apiKey: null, usage: r.usage, promptText: prompt, replyText: r.finalText });
      broadcast({ type: "assistant_message", text: r.finalText });
      broadcast({ type: "changes", files: r.changes });
      lastTurnDiff = { project, manifest, changes: r.changes };
      broadcast({ type: "turn_done" });
      return;
    } catch (e) {
      const msg = cleanError(e);
      finalizeTurnUsage({ providerId: attempt.providerId, modelId: attempt.modelId, apiKey: null, usage: null, promptText: prompt, replyText: "", error: msg });
      const kind =
        classifyProxyError(msg) ||
        (e && typeof e.code === "string" ? e.code : null);
      if (kind === "insufficient_credit") {
        const err = new Error("Your Ronin credit has run out. Buy a credit pack to keep going.");
        err.code = "insufficient_credit";
        throw err;
      }
      if (kind === "account_suspended") {
        // Refresh the cached account state (which also drops the
        // stored key when the account is disabled) and surface the
        // existing locked state.
        try { await authManager.revalidate(); } catch {}
        const err = new Error("Your Ronin account is currently suspended.");
        err.code = "subscription_locked";
        throw err;
      }
      if (kind === "model_disabled") {
        const err = new Error("That model is not available on your subscription right now.");
        err.code = "model_disabled";
        throw err;
      }
      if (kind === "provider_key_not_ready") {
        const err = new Error("Your subscription key is still being set up. Please try again in a moment.");
        err.code = "provider_key_not_ready";
        throw err;
      }
      if ((kind === "unauthorized" || kind === "provider_key_invalid") && attempt.transport === "direct") {
        // Direct provider 401: frozen/invalid delegated key. One
        // credential re-fetch may heal it (rotated/replacement key —
        // same §5.2c signal as the relay); if it does not, the
        // existing locked state applies. Revalidate first so the
        // cached account state (and the stored key, when the server
        // reports the account/key disabled) is current.
        if (!retriedAfterRefetch && !state.visible) {
          retriedAfterRefetch = true;
          let healed = false;
          if (typeof authManager.refreshSubscriptionCredential === "function") {
            const before = typeof authManager.getSubscriptionKeyFingerprint === "function"
              ? authManager.getSubscriptionKeyFingerprint()
              : null;
            try { await authManager.refreshSubscriptionCredential(); } catch {}
            const after = typeof authManager.getSubscriptionKeyFingerprint === "function"
              ? authManager.getSubscriptionKeyFingerprint()
              : null;
            healed = Boolean(after) && after !== before;
          }
          if (healed) continue;
        }
        try { await authManager.revalidate(); } catch {}
        const err = new Error("Your Ronin subscription is not active for this device.");
        err.code = "subscription_locked";
        throw err;
      }
      const keyShaped = kind === "unauthorized" || kind === "provider_key_invalid";
      if (keyShaped && !retriedAfterRefetch && !state.visible) {
        retriedAfterRefetch = true;
        // §5.2(c): re-fetch the credential on a key-shaped signal. In
        // per-user mode a rotated/replacement key heals the turn; in
        // shared mode there is no credential to fetch and the session
        // path below applies instead.
        let healed = false;
        if (
          attempt.routingMode === "per_user" &&
          typeof authManager.refreshSubscriptionCredential === "function"
        ) {
          const before = typeof authManager.getSubscriptionKeyFingerprint === "function"
            ? authManager.getSubscriptionKeyFingerprint()
            : null;
          try { await authManager.refreshSubscriptionCredential(); } catch {}
          const after = typeof authManager.getSubscriptionKeyFingerprint === "function"
            ? authManager.getSubscriptionKeyFingerprint()
            : null;
          healed = Boolean(after) && after !== before;
          if (!healed && kind === "provider_key_invalid") {
            // §6.4: an invalid key with no replacement is a generic
            // turn error (human first) — not a login failure.
            throw e;
          }
        }
        if (healed) continue;
      }
      if (kind === "unauthorized" || kind === "login_required") {
        await authManager.revalidate();
        if (!authManager.state().loggedIn) {
          const err = new Error("Your Ronin session has ended. Please sign in again.");
          err.code = "login_required";
          throw err;
        }
        throw e;
      }
      throw e;
    }
  }
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
