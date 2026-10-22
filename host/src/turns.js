import { log } from "./log.js";
// Ronin Code — local host service.
// Turn orchestration: dispatch (preview/live), the plan-mode gate
// (propose → approve → execute with live step progress), plan
// revisions, and idea maturation.

import os from "node:os";
import crypto from "node:crypto";
import { config, getProject, loadAuth, keyList, effectiveAutoMode, effectivePlanMode } from "./config.js";
import { cleanError } from "./util.js";
import { broadcast } from "./sse.js";
import { takeSnapshot } from "./snapshots.js";
import {
  runPreviewTurn, runLiveTurn, runJsonPrompt, parseJsonBlock, emitActivity, runActivity,
} from "./engine.js";

let turnRunning = false;
export function isTurnRunning() { return turnRunning; }
export function setTurnRunning(v) { turnRunning = v; }

let pendingPlan = null; // { id, task, steps: [{title, detail}], project }
export function getPendingPlan() { return pendingPlan; }
export function setPendingPlan(p) { pendingPlan = p; }

export const previewSteps = () =>
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

export async function proposePlan(task, project) {
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
    log.error("plan_proposal_failed", { error: cleanError(e) });
  } finally {
    await activity.end();
  }
  return { steps: previewSteps(), simulated: true };
}

export async function executePlannedTurn(plan) {
  const project = getProject();
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

export async function matureIdea(idea, project) {
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

export async function runTurn(prompt, opts = {}) {
  const turnId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  log.info("turn_started", { turnId, kind: opts.kind ?? "turn" });
  const project = getProject();
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
    try { manifest = await takeSnapshot(project); } catch (e) { log.error("snapshot_failed", { error: cleanError(e) }); }
    const auth = loadAuth();
    if (!keyList(auth[config.provider]).length) {
      await runPreviewTurn();
    } else {
      await runLiveTurn(prompt, project, manifest, { autoMode: effectiveAutoMode(project) });
    }
  } catch (e) {
    log.error("turn_failed", { turnId, error: cleanError(e) });
    broadcast({ type: "turn_error", message: cleanError(e) || "Something went wrong during that turn. Please try again." });
  } finally {
    turnRunning = false;
    log.info("turn_finished", { turnId, durationMs: Date.now() - startedAt });
  }
}

// ---------- named checkpoints ----------
