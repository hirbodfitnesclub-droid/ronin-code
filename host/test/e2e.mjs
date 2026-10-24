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
const RONIN_PORT = 7412;
const BASE = `http://127.0.0.1:${HOST_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const RONIN = `http://127.0.0.1:${RONIN_PORT}`;
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
const ronin = spawn("node", ["host/test/mock-ronin.mjs"], {
  cwd: path.resolve("host/.."),
  env: { ...process.env, RONIN_STUB_PORT: String(RONIN_PORT) },
  stdio: "pipe",
});
const host = spawn("node", ["host/src/server.js"], {
  cwd: path.resolve("host/.."),
  env: {
    ...process.env,
    RONIN_HOME: HOME,
    RONIN_PROJECTS_DIR: PROJECTS,
    PORT: String(HOST_PORT),
    RONIN_SERVER_URL: RONIN,
    RONIN_PANEL_URL: "http://127.0.0.1:5999",
  },
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

const roninControl = async (body) => {
  await fetch(`${RONIN}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};
const roninRequests = async () => (await fetch(`${RONIN}/__requests`)).json();
const roninState = async () => (await fetch(`${RONIN}/__state`)).json();
const mockControl = async (body) => {
  await fetch(`${MOCK}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};
const mockRequests = async () => (await fetch(`${MOCK}/__requests`)).json();

// ---------- AUTH-A: turns are gated before login ----------
{
  const pre = await api("POST", "/api/turn", { prompt: "hello before login" });
  check("AUTH-A: POST /api/turn before login -> 401 login_required",
    pre.status === 401 && pre.json.error === "login_required", `status=${pre.status}`);
}

// ---------- AUTH-B: handoff exchange logs the host in ----------
{
  const login = await api("POST", "/api/auth/exchange-code", { code: "e2e-handoff" });
  check("AUTH-B: exchange-code succeeds with the user", login.status === 200 && login.json.ok === true && login.json.user?.id === "u1");
  const st = await api("GET", "/api/auth/state");
  check("AUTH-B: /api/auth/state reports loggedIn + user",
    st.json.loggedIn === true && st.json.user?.id === "u1");
  check("AUTH-B: subscription cached from account-status",
    st.json.subscription?.status === "active" && st.json.subscription?.deviceAuthorized === true);
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

// ---------- SUB-C: subscription turn through the metering proxy ----------
await api("POST", "/api/settings", { enabledModels: ["gpt-6-luna"] });
{
  mark = events.length;
  const accepted = await api("POST", "/api/turn", {
    prompt: "Say hello via subscription",
    modelId: "gpt-6-luna",
    effort: "high",
    fast: true,
  });
  check("SUB-C: subscription turn accepted", accepted.status === 200, `status=${accepted.status}`);
  const doneSub = await waitEvent("turn_done", 60000, mark);
  check("SUB-C: subscription turn completes", Boolean(doneSub));
  const errSub = events.slice(mark).find((e) => e.type === "turn_error");
  check("SUB-C: no turn_error on the subscription turn", !errSub, errSub ? JSON.stringify(errSub) : "");
  const reqs = await roninRequests();
  const last = reqs.proxy[reqs.proxy.length - 1];
  check("SUB-C: proxy saw model + reasoning_effort + fast header",
    Boolean(last) && last.body.model === "gpt-6-luna" && last.body.reasoning_effort === "high" && last.headers["x-ronin-fast"] === "1",
    last ? `model=${last.body.model} effort=${last.body.reasoning_effort} fast=${last.headers["x-ronin-fast"]}` : "no proxy request");
  const st = await api("GET", "/api/status");
  check("SUB-C: status.activeModelId persisted", st.json.activeModelId === "gpt-6-luna", `activeModelId=${st.json.activeModelId}`);
  check("SUB-C: status carries the auth slice", st.json.auth?.loggedIn === true && st.json.enabledModels?.includes("gpt-6-luna"));
}

// ---------- SUB-D: disabled subscription blocks sub turns, not BYOK ----------
{
  await roninControl({ account: { status: "disabled", isActive: false } });
  await api("POST", "/api/auth/refresh-status", {});
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription while disabled", modelId: "gpt-6-luna" });
  const errD = await waitEvent("turn_error", 30000, mark, (e) => e.code === "subscription_locked");
  check("SUB-D: subscription turn blocked with subscription_locked", Boolean(errD));
  await api("POST", "/api/settings", { autoMode: true });
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "SCENARIO:bash CMD:touch LEGACY_OK" });
  const doneLegacy = await waitEvent("turn_done", 30000, mark);
  check("SUB-D: legacy BYOK turn still succeeds while subscription disabled",
    Boolean(doneLegacy) && fs.existsSync(path.join(project, "LEGACY_OK")));
  await roninControl({ account: { status: "active", isActive: true } });
  await api("POST", "/api/auth/refresh-status", {});
}

// ---------- SUB-E: proxy 402 maps to insufficient_credit ----------
{
  await roninControl({ proxyMode: "402" });
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription with no credit", modelId: "gpt-6-luna" });
  const errE = await waitEvent("turn_error", 90000, mark, (e) => e.code === "insufficient_credit");
  check("SUB-E: proxy 402 -> turn_error insufficient_credit", Boolean(errE));
  await roninControl({ proxyMode: "ok" });
}

// ---------- SUB-G: per-user mode — delegated key is fetched, stored, and used ----------
{
  const FAKE1 = "sk-ronin-FAKE-e2e-key-0001";
  await roninControl({ routingMode: "per_user" });
  await api("POST", "/api/auth/refresh-status", {});
  const credsG = JSON.parse(fs.readFileSync(path.join(HOME, "credentials.json"), "utf8"));
  check("SUB-G: delegated key stored in credentials.json", credsG.subscriptionKey === FAKE1);
  check("SUB-G: credential fingerprint stored, routingMode per_user",
    typeof credsG.subscriptionKeyFingerprint === "string" && credsG.routingMode === "per_user");
  const authJsonG = fs.existsSync(path.join(HOME, "auth.json")) ? fs.readFileSync(path.join(HOME, "auth.json"), "utf8") : "";
  const configJsonG = fs.existsSync(path.join(HOME, "config.json")) ? fs.readFileSync(path.join(HOME, "config.json"), "utf8") : "";
  check("SUB-G: delegated key never lands in auth.json / config.json",
    !authJsonG.includes(FAKE1) && !configJsonG.includes(FAKE1));
  const stG = await api("GET", "/api/auth/state");
  check("SUB-G: GUI state carries only the masked key",
    stG.json.subscription?.subscriptionKeyMasked === `••••${FAKE1.slice(-4)}` &&
      !JSON.stringify(stG.json).includes(FAKE1));
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription via delegated key", modelId: "gpt-6-luna" });
  const doneG = await waitEvent("turn_done", 60000, mark);
  check("SUB-G: per-user subscription turn completes", Boolean(doneG));
  const reqsG = await roninRequests();
  const lastG = reqsG.proxy[reqsG.proxy.length - 1];
  check("SUB-G: relay received the delegated key (dual-auth), not the session token",
    Boolean(lastG) && lastG.authKind === "delegated" && lastG.headers.authorization === `Bearer ${FAKE1}`,
    lastG ? `authKind=${lastG.authKind}` : "no proxy request");
  check("SUB-G: credential endpoint was fetched", reqsG.credentialFetches >= 1, `fetches=${reqsG.credentialFetches}`);
}

// ---------- SUB-H: relay 403 account_suspended -> subscription_locked (never model_disabled) ----------
{
  await roninControl({ proxyMode: "suspended" });
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription while frozen at relay", modelId: "gpt-6-luna" });
  const errH = await waitEvent("turn_error", 90000, mark, (e) => e.code === "subscription_locked");
  check("SUB-H: relay account_suspended -> turn_error subscription_locked", Boolean(errH));
  const wrongH = events.slice(mark).find((e) => e.type === "turn_error" && e.code === "model_disabled");
  check("SUB-H: suspended is never mislabelled model_disabled", !wrongH);
  await roninControl({ proxyMode: "ok" });
}

// ---------- SUB-I: stale key self-heals via one credential re-fetch + retry ----------
{
  const FAKE2 = "sk-ronin-FAKE-e2e-key-0002";
  const before = await roninRequests();
  await roninControl({ credentialKey: FAKE2 }); // provider-side rotation; host still holds FAKE1
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription after key rotation", modelId: "gpt-6-luna" });
  const doneI = await waitEvent("turn_done", 90000, mark);
  check("SUB-I: turn self-heals after stale-key 401 and completes", Boolean(doneI));
  const after = await roninRequests();
  check("SUB-I: exactly one extra credential fetch for the heal",
    after.credentialFetches === before.credentialFetches + 1,
    `before=${before.credentialFetches} after=${after.credentialFetches}`);
  const lastI = after.proxy[after.proxy.length - 1];
  check("SUB-I: retry reached the relay with the rotated key",
    Boolean(lastI) && lastI.headers.authorization === `Bearer ${FAKE2}`);
  const credsI = JSON.parse(fs.readFileSync(path.join(HOME, "credentials.json"), "utf8"));
  check("SUB-I: rotated key persisted", credsI.subscriptionKey === FAKE2);
}

// ---------- SUB-J: direct transport — turn goes to the provider, never the relay ----------
{
  const FAKE2 = "sk-ronin-FAKE-e2e-key-0002"; // current key after SUB-I rotation
  await roninControl({ providerBaseUrl: `${MOCK}/v1` });
  const proxyBefore = (await roninRequests()).proxy.length;
  const mockBefore = (await mockRequests()).length;
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription going direct to the provider", modelId: "gpt-6-luna" });
  const doneJ = await waitEvent("turn_done", 60000, mark);
  check("SUB-J: direct subscription turn completes", Boolean(doneJ));
  const errJ = events.slice(mark).find((e) => e.type === "turn_error");
  check("SUB-J: no turn_error on the direct turn", !errJ, errJ ? JSON.stringify(errJ) : "");
  const mockAfter = await mockRequests();
  const directReqs = mockAfter.slice(mockBefore);
  check("SUB-J: the turn landed on the mock PROVIDER with the delegated key",
    directReqs.length >= 1 && directReqs.every((r) => r.auth === `Bearer ${FAKE2}`),
    directReqs.length ? `auth=${directReqs[0].auth}` : "no provider request");
  check("SUB-J: provider request carries the catalog model",
    directReqs.length >= 1 && directReqs[0].body.model === "gpt-6-luna",
    directReqs.length ? `model=${directReqs[0].body.model}` : "");
  const proxyAfter = (await roninRequests()).proxy.length;
  check("SUB-J: the Ronin relay /v1/chat/completions was never touched",
    proxyAfter === proxyBefore, `before=${proxyBefore} after=${proxyAfter}`);
  const credsJ = JSON.parse(fs.readFileSync(path.join(HOME, "credentials.json"), "utf8"));
  check("SUB-J: providerBaseUrl persisted alongside the delegated key",
    credsJ.providerBaseUrl === `${MOCK}/v1` && credsJ.subscriptionKey === FAKE2);
}

// ---------- SUB-K: direct provider 402 -> insufficient_credit ----------
{
  await mockControl({ directMode: "402" });
  const proxyBefore = (await roninRequests()).proxy.length;
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "direct subscription with no credit", modelId: "gpt-6-luna" });
  const errK = await waitEvent("turn_error", 90000, mark, (e) => e.code === "insufficient_credit");
  check("SUB-K: direct provider 402 -> turn_error insufficient_credit", Boolean(errK));
  check("SUB-K: the 402 came from the provider, not the relay",
    (await roninRequests()).proxy.length === proxyBefore);
  await mockControl({ directMode: "ok" });
}

// ---------- SUB-L: direct provider 401 -> subscription_locked ----------
{
  await mockControl({ directMode: "401" });
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "direct subscription with a frozen key", modelId: "gpt-6-luna" });
  const errL = await waitEvent("turn_error", 90000, mark, (e) => e.code === "subscription_locked");
  check("SUB-L: direct provider 401 -> turn_error subscription_locked", Boolean(errL));
  const loginErrL = events.slice(mark).find((e) => e.type === "turn_error" && e.code === "login_required");
  check("SUB-L: provider 401 is not mislabelled login_required", !loginErrL);
  await mockControl({ directMode: "ok" });
  // Restore the pre-direct server shape for the remaining sections.
  await roninControl({ providerBaseUrl: null });
}

// ---------- SUB-F: refresh rotation persists the newest token ----------
{
  await roninControl({ tokenTtlSec: 30 });
  await api("POST", "/api/auth/logout", {});
  const relogin = await api("POST", "/api/auth/exchange-code", { code: "e2e-handoff-2" });
  check("SUB-F: re-login with short-lived access token", relogin.status === 200 && relogin.json.ok === true);
  mark = events.length;
  await api("POST", "/api/turn", { prompt: "subscription after rotation", modelId: "gpt-6-luna" });
  const doneF2 = await waitEvent("turn_done", 60000, mark);
  check("SUB-F: subscription turn succeeds after refresh rotation", Boolean(doneF2));
  const stubState = await roninState();
  const creds = JSON.parse(fs.readFileSync(path.join(HOME, "credentials.json"), "utf8"));
  check("SUB-F: host persisted the newest refresh token",
    creds.refreshToken === stubState.currentRefresh, `disk=${creds.refreshToken} stub=${stubState.currentRefresh}`);
  check("SUB-F: refresh tokens rotated without reuse",
    stubState.refreshSeen.length >= 2 && new Set(stubState.refreshSeen).size === stubState.refreshSeen.length,
    `refreshSeen=${stubState.refreshSeen.join(",")}`);
  const authState = await api("GET", "/api/auth/state");
  check("SUB-F: still logged in after rotations", authState.json.loggedIn === true);
  await roninControl({ tokenTtlSec: 3600 });
}

mock.kill();
ronin.kill();
host.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(process.exitCode || 0);
