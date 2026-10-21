// Ronin Code host E2E — drives the real host + embedded engine against a
// mock OpenAI-compatible provider. Verifies the v1 trust layer end-to-end:
// approval gate (deny/allow), Auto mode, .env protection, secret redaction,
// RTK compression, multi-key failover, cost recording, plan mode, ideas.
//
// Run: node host/test/e2e.mjs   (exit code 0 = all green)

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOST_PORT = 7331;
const MOCK_PORT = 7411;
const BASE = `http://127.0.0.1:${HOST_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const TMP = "/tmp/ronin-e2e";
const HOME = path.join(TMP, "home");
const PROJECTS = path.join(TMP, "projects");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fsp.rm(TMP, { recursive: true, force: true });
await fsp.mkdir(HOME, { recursive: true });
await fsp.mkdir(PROJECTS, { recursive: true });

const mock = spawn("node", ["host/test/mock-provider.mjs"], {
  cwd: path.resolve("host/.."),
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: "pipe",
});
const host = spawn("node", ["host/src/server.js"], {
  cwd: path.resolve("host/.."),
  env: { ...process.env, RONIN_HOME: HOME, RONIN_PROJECTS_DIR: PROJECTS, PORT: String(HOST_PORT) },
  stdio: "pipe",
});
host.stderr.on("data", (d) => process.stderr.write(`[host] ${d}`));

async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}
if (!(await waitHealth())) {
  console.error("host did not start");
  process.exit(1);
}
await sleep(500); // mock

const cfgJs = await (await fetch(`${BASE}/ronin-config.js`)).text();
const TOKEN = cfgJs.match(/"([0-9a-f]{48})"/)[1];
const api = async (method, route, body) => {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Ronin-Token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: text }; }
};

// ---------- SSE collector ----------
const events = [];
{
  const res = await fetch(`${BASE}/api/stream?token=${TOKEN}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          try { events.push(JSON.parse(dataLine.slice(6))); } catch {}
        }
      }
    }
  })().catch(() => {});
}
async function waitEvent(type, timeoutMs = 30000, fromIndex = 0, filter = () => true) {
  const t0 = Date.now();
  for (;;) {
    for (let i = fromIndex; i < events.length; i++) {
      if (events[i].type === type && filter(events[i])) return { ev: events[i], index: i };
    }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}

// ---------- setup: custom provider + project ----------
await api("POST", "/api/settings", {
  provider: "custom",
  baseUrl: `${MOCK}/v1`,
  model: "mock-1",
  apiKey: "mock-key-1",
  onboarded: true,
});
const starter = await api("POST", "/api/projects/starter", {});
const project = starter.json.path;
check("setup: starter project created", Boolean(project) && fs.existsSync(path.join(project, "index.html")));
await fsp.writeFile(path.join(project, ".env"), "API_KEY=TOPSECRETVALUE123\n");

// ---------- A: approval gate DENIES a command ----------
let mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:bash CMD:touch APMARKER_DENY" });
const apprA = await waitEvent("approval_request", 30000, mark);
check("A: bash triggers approval request", Boolean(apprA));
if (apprA) await api("POST", `/api/approvals/${apprA.ev.approvalId}`, { approved: false });
const doneA = await waitEvent("turn_done", 30000, mark);
check("A: turn completes after deny", Boolean(doneA));
check("A: denied command did not run", !fs.existsSync(path.join(project, "APMARKER_DENY")));

// ---------- B: approval gate ALLOWS a command ----------
mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:bash CMD:touch APMARKER_ALLOW" });
const apprB = await waitEvent("approval_request", 30000, mark);
check("B: bash triggers approval request", Boolean(apprB));
if (apprB) await api("POST", `/api/approvals/${apprB.ev.approvalId}`, { approved: true });
await waitEvent("turn_done", 30000, mark);
check("B: allowed command ran", fs.existsSync(path.join(project, "APMARKER_ALLOW")));

// ---------- C: Auto mode skips approvals ----------
await api("POST", "/api/settings", { autoMode: true });
mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:bash CMD:touch APMARKER_AUTO" });
const doneC = await waitEvent("turn_done", 30000, mark);
const apprC = events.slice(mark).find((e) => e.type === "approval_request");
check("C: auto mode turn completes", Boolean(doneC));
check("C: auto mode requests no approval", !apprC);
check("C: auto mode command ran", fs.existsSync(path.join(project, "APMARKER_AUTO")));

// ---------- D: .env read is blocked even in Auto mode ----------
mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:env" });
const doneD = await waitEvent("turn_done", 30000, mark);
check("D: env turn completes", Boolean(doneD));
const mockReqsD = await (await fetch(`${MOCK}/__requests`)).json();
const toolMsgD = JSON.stringify(mockReqsD.map((r) => r.body.messages).flat());
check("D: .env content never reached the provider", !toolMsgD.includes("TOPSECRETVALUE123"));
check("D: block reason surfaced to the engine", toolMsgD.includes("protected"));

// ---------- E: RTK compression + secret redaction on tool output ----------
mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:noisy" });
const doneE = await waitEvent("turn_done", 30000, mark);
check("E: noisy turn completes", Boolean(doneE));
const mockReqsE = await (await fetch(`${MOCK}/__requests`)).json();
const toolResultsE = mockReqsE
  .map((r) => r.body.messages || [])
  .flat()
  .filter((m) => m.role === "tool")
  .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
  .join("\n");
check("E: repeated lines collapsed", toolResultsE.includes("repeated"));
check("E: fake secret redacted from tool output", !toolResultsE.includes("FAKESECRETKEY"));
const usageE = await api("GET", "/api/usage");
check("E: RTK savings recorded", usageE.json.rtk.savedChars > 0, `savedChars=${usageE.json.rtk.savedChars}`);

// ---------- F: multi-key failover on 429 + cost recording ----------
await api("POST", "/api/settings", { apiKeys: ["mock-key-1", "mock-key-2"], keysProvider: "custom" });
await api("POST", "/api/settings", { autoMode: true });
mark = events.length;
await api("POST", "/api/turn", { prompt: "MOCK:429 please do the thing" });
const doneF = await waitEvent("turn_done", 90000, mark);
check("F: failover turn completes", Boolean(doneF));
const switchedF = events.slice(mark).find((e) => e.type === "provider_switched");
check("F: provider_switched emitted", Boolean(switchedF));
const provF = await api("GET", "/api/providers");
const custom = provF.json.find((p) => p.id === "custom");
check("F: two keys registered", custom.keys.length === 2, `keys=${custom.keys.length}`);
check("F: failing key recorded the 429 error", custom.keys.some((k) => k.errors >= 1), `errors=${custom.keys.map((k) => k.errors).join(",")}`);
check("F: both keys were used", custom.keys.every((k) => k.requests >= 1), `requests=${custom.keys.map((k) => k.requests).join(",")}`);
check("F: cost recorded for turns", usageE.json.totals.costUsd >= 0 && (await api("GET", "/api/usage")).json.totals.turns >= 5);

// ---------- G: plan mode (propose -> approve -> execute) ----------
await api("POST", "/api/settings", { autoMode: false, planMode: true });
mark = events.length;
await api("POST", "/api/turn", { prompt: "Add a pricing section" });
const proposed = await waitEvent("plan_proposed", 30000, mark);
check("G: plan proposed", Boolean(proposed) && proposed.ev.steps.length === 3);
if (proposed) {
  // The proposal turn ends with its own turn_done — execution events come after it.
  const proposalDone = await waitEvent("turn_done", 30000, proposed.index);
  const execFrom = proposalDone ? proposalDone.index + 1 : proposed.index + 1;
  await api("POST", "/api/plan/approve", { planId: proposed.ev.planId });
  const apprG = await waitEvent("approval_request", 30000, execFrom);
  check("G: execution still passes the approval gate", Boolean(apprG));
  if (apprG) await api("POST", `/api/approvals/${apprG.ev.approvalId}`, { approved: true });
  const doneG = await waitEvent("turn_done", 30000, execFrom);
  check("G: planned turn completes", Boolean(doneG));
  check("G: planned work executed", fs.existsSync(path.join(project, "PLANMARKER")));
}
await api("POST", "/api/settings", { planMode: false });

// ---------- H: idea maturation (live JSON) ----------
const mature = await api("POST", "/api/ideas/mature", { idea: "A booking app for barbers" });
check("H: idea matured with audience/features/plan",
  Boolean(mature.json.audience?.who) && mature.json.features?.length === 3 && mature.json.plan?.length === 2);

// ---------- I: write outside project requires approval ----------
mark = events.length;
await api("POST", "/api/turn", { prompt: "SCENARIO:outside" });
const apprI = await waitEvent("approval_request", 30000, mark);
check("I: outside write triggers approval", Boolean(apprI) && apprI.ev.kind === "write_outside");
if (apprI) await api("POST", `/api/approvals/${apprI.ev.approvalId}`, { approved: false });
await waitEvent("turn_done", 30000, mark);
check("I: denied outside write did not happen", !fs.existsSync("/tmp/ronin-e2e/outside.txt"));

mock.kill();
host.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(process.exitCode || 0);
