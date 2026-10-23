// Ronin Code host E2E — HARD battery (Phase 2 tech-lead addendum).
// Relay-abuse + client-security scenarios against the stub Ronin
// server (host/test/mock-ronin.mjs) with per-user keys enabled:
//   H1 provider 402 MID-STREAM -> insufficient_credit, bounded retries
//   H2 upstream hangs then closes early -> clean error + recovery
//   H3 key frozen WHILE streaming -> in-flight completes; the NEXT
//      request surfaces subscription_locked (never model_disabled)
//   H4 two devices, one user, one key, concurrent streams
//   H5 the delegated key never appears in host logs / GUI payloads
//   H6 corrupted local credential entry -> clean re-fetch, and the
//      proxy proves the delegated key (not the session token) is used
// GUI landing for H1/H3 codes is covered by gui/test/turn-errors.test.ts
// (insufficient_credit -> credit banner, subscription_locked -> locked).
//
// Run: node host/test/e2e-hard.mjs   (exit code 0 = all green)

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const RONIN_PORT = 7413;
const RONIN = `http://127.0.0.1:${RONIN_PORT}`;
const TMP = "/tmp/ronin-e2e-hard";
const FAKE1 = "sk-ronin-FAKE-e2e-key-0001";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fsp.rm(TMP, { recursive: true, force: true });
await fsp.mkdir(TMP, { recursive: true });

const output = { host1: "", host2: "", ronin: "" };
function spawnLogged(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  p.stdout.on("data", (d) => { output[name] += d.toString(); });
  p.stderr.on("data", (d) => { output[name] += d.toString(); });
  return p;
}

const ronin = spawnLogged("ronin", "node", ["host/test/mock-ronin.mjs"], {
  cwd: path.resolve("host/.."),
  env: { ...process.env, RONIN_STUB_PORT: String(RONIN_PORT) },
  stdio: "pipe",
});

function makeHost(port, home) {
  const proc = spawnLogged(port === 7332 ? "host1" : "host2", "node", ["host/src/server.js"], {
    cwd: path.resolve("host/.."),
    env: {
      ...process.env,
      RONIN_HOME: home,
      RONIN_PROJECTS_DIR: path.join(home, "projects"),
      PORT: String(port),
      RONIN_SERVER_URL: RONIN,
      RONIN_PANEL_URL: "http://127.0.0.1:5999",
    },
    stdio: "pipe",
  });
  return { proc, port, home, base: `http://127.0.0.1:${port}` };
}

async function wireClient(host) {
  // Wait for health, then read the GUI token the host serves.
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${host.base}/health`)).ok) break; } catch {}
    await sleep(250);
  }
  const cfgJs = await (await fetch(`${host.base}/ronin-config.js`)).text();
  const TOKEN = cfgJs.match(/"([0-9a-f]{48})"/)[1];
  const api = async (method, route, body) => {
    const r = await fetch(`${host.base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Ronin-Token": TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: text }; }
  };
  const events = [];
  const res = await fetch(`${host.base}/api/stream?token=${TOKEN}`);
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
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
      }
    }
  })().catch(() => {});
  async function waitEvent(type, timeoutMs = 90000, fromIndex = 0, filter = () => true) {
    const t0 = Date.now();
    for (;;) {
      for (let i = fromIndex; i < events.length; i++) {
        if (events[i].type === type && filter(events[i])) return { ev: events[i], index: i };
      }
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(150);
    }
  }
  return { api, events, waitEvent };
}

const roninControl = async (body) => {
  await fetch(`${RONIN}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};
const roninRequests = async () => (await fetch(`${RONIN}/__requests`)).json();
const proxyCount = async () => (await roninRequests()).proxy.length;

// ---------- setup: host1 logged in, per-user mode ----------
const host1 = makeHost(7332, path.join(TMP, "home1"));
const c1 = await wireClient(host1);
await roninControl({ routingMode: "per_user", credentialKeyStatus: "active", proxyMode: "ok" });
{
  const login = await c1.api("POST", "/api/auth/exchange-code", { code: "hard-handoff" });
  check("setup: host1 login", login.status === 200 && login.json.ok === true);
  await c1.api("POST", "/api/settings", { enabledModels: ["gpt-6-luna"], onboarded: true });
  const starter = await c1.api("POST", "/api/projects/starter", {});
  check("setup: host1 starter project", Boolean(starter.json.path));
  const creds = JSON.parse(fs.readFileSync(path.join(host1.home, "credentials.json"), "utf8"));
  check("setup: host1 holds the delegated key", creds.subscriptionKey === FAKE1);
}

// ---------- H1: provider 402 MID-STREAM ----------
{
  await roninControl({ proxyMode: "402-midstream" });
  const before = await proxyCount();
  const mark = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "mid-stream credit cut", modelId: "gpt-6-luna" });
  const err = await c1.waitEvent("turn_error", 120000, mark, (e) => e.code === "insufficient_credit");
  check("H1: mid-stream 402 -> turn_error insufficient_credit (GUI credit banner)", Boolean(err));
  const partial = c1.events.slice(mark).find((e) => e.type === "assistant_delta");
  check("H1: partial content streamed before the cut", Boolean(partial));
  const doneAfterErr = c1.events.slice(mark).find((e) => e.type === "turn_done");
  check("H1: partial stream terminated (no turn_done for the cut turn)", !doneAfterErr);
  await sleep(2500);
  const after = await proxyCount();
  check("H1: no retry storm (bounded provider attempts)", after - before >= 1 && after - before <= 4, `attempts=${after - before}`);
  const stable = await proxyCount();
  await sleep(1500);
  check("H1: provider attempts stay settled after the error", (await proxyCount()) === stable);
  await roninControl({ proxyMode: "ok" });
  const mark2 = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "recovery after mid-stream cut", modelId: "gpt-6-luna" });
  const done = await c1.waitEvent("turn_done", 90000, mark2);
  check("H1: session recovers — next turn completes", Boolean(done));
}

// ---------- H2: upstream hangs, then closes early ----------
{
  await roninControl({ proxyMode: "hang-close" });
  const mark = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "hang then close", modelId: "gpt-6-luna" });
  const err = await c1.waitEvent("turn_error", 120000, mark);
  check("H2: hang-close surfaces a clean turn_error", Boolean(err), err ? `code=${err.ev.code || "generic"}` : "");
  check("H2: error is not mislabelled as credit/locked",
    Boolean(err) && err.ev.code !== "insufficient_credit" && err.ev.code !== "subscription_locked");
  const st = await c1.api("GET", "/api/status");
  check("H2: host stays responsive after the aborted stream", st.status === 200);
  await roninControl({ proxyMode: "ok" });
  const mark2 = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "recovery after hang", modelId: "gpt-6-luna" });
  const done = await c1.waitEvent("turn_done", 90000, mark2);
  check("H2: composer/session not wedged — next turn completes", Boolean(done));
}

// ---------- H3: key frozen WHILE a stream is in flight ----------
{
  await roninControl({ proxyMode: "slow", credentialKeyStatus: "active" });
  const before = await proxyCount();
  const mark = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "long stream during freeze", modelId: "gpt-6-luna" });
  // Wait until the stream is actually in flight, then freeze the key.
  for (let i = 0; i < 40 && (await proxyCount()) === before; i++) await sleep(150);
  await roninControl({ credentialKeyStatus: "frozen" });
  const done = await c1.waitEvent("turn_done", 90000, mark);
  check("H3: in-flight stream completes despite the mid-stream freeze", Boolean(done));
  // Next request hits the relay's frozen gate.
  await roninControl({ proxyMode: "ok" });
  const mark2 = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "first turn after freeze", modelId: "gpt-6-luna" });
  const err = await c1.waitEvent("turn_error", 120000, mark2, (e) => e.code === "subscription_locked");
  check("H3: next request surfaces subscription_locked via the fixed classifier", Boolean(err));
  const wrong = c1.events.slice(mark2).find((e) => e.type === "turn_error" && e.code === "model_disabled");
  check("H3: frozen is NOT mislabelled model_disabled", !wrong);
  // Unfreeze + revalidate (re-fetches the credential) restores service.
  await roninControl({ credentialKeyStatus: "active" });
  await c1.api("POST", "/api/auth/refresh-status", {});
  const mark3 = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "recovery after unfreeze", modelId: "gpt-6-luna" });
  const done3 = await c1.waitEvent("turn_done", 90000, mark3);
  check("H3: unfreeze + credential re-fetch restores turns", Boolean(done3));
}

// ---------- H4: two devices, same user + key, concurrent streams ----------
const host2 = makeHost(7333, path.join(TMP, "home2"));
const c2 = await wireClient(host2);
{
  const login2 = await c2.api("POST", "/api/auth/exchange-code", { code: "hard-handoff-device2" });
  check("H4: device 2 login", login2.status === 200 && login2.json.ok === true);
  await c2.api("POST", "/api/settings", { enabledModels: ["gpt-6-luna"], onboarded: true });
  await c2.api("POST", "/api/projects/starter", {});
  await roninControl({ proxyMode: "slow" });
  const mark1 = c1.events.length;
  const mark2 = c2.events.length;
  await Promise.all([
    c1.api("POST", "/api/turn", { prompt: "device one concurrent", modelId: "gpt-6-luna" }),
    c2.api("POST", "/api/turn", { prompt: "device two concurrent", modelId: "gpt-6-luna" }),
  ]);
  const [d1, d2] = await Promise.all([
    c1.waitEvent("turn_done", 120000, mark1),
    c2.waitEvent("turn_done", 120000, mark2),
  ]);
  check("H4: both concurrent device streams complete", Boolean(d1) && Boolean(d2));
  const reqs = await roninRequests();
  const last2 = reqs.proxy.slice(-2);
  check("H4: both devices authenticated with the same delegated key",
    last2.length === 2 && last2.every((r) => r.authKind === "delegated" && r.headers.authorization === `Bearer ${FAKE1}`));
  for (const [label, home] of [["device1", host1.home], ["device2", host2.home]]) {
    const p = path.join(home, "credentials.json");
    const creds = JSON.parse(fs.readFileSync(p, "utf8"));
    check(`H4: ${label} credential store intact after concurrency`,
      creds.subscriptionKey === FAKE1 && (fs.statSync(p).mode & 0o777) === 0o600);
  }
  await roninControl({ proxyMode: "ok" });
}

// ---------- H6: corrupted local credential entry -> clean re-fetch ----------
{
  const p = path.join(host1.home, "credentials.json");
  const creds = JSON.parse(fs.readFileSync(p, "utf8"));
  creds.subscriptionKey = 123456789; // wrong type
  creds.subscriptionKeyFingerprint = "junk-fingerprint";
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  await c1.api("POST", "/api/auth/refresh-status", {});
  const healed = JSON.parse(fs.readFileSync(p, "utf8"));
  check("H6: corrupted entry healed by clean re-fetch (no crash)", healed.subscriptionKey === FAKE1);
  const before = await proxyCount();
  const mark = c1.events.length;
  await c1.api("POST", "/api/turn", { prompt: "turn after corruption heal", modelId: "gpt-6-luna" });
  const done = await c1.waitEvent("turn_done", 90000, mark);
  check("H6: turn after heal completes", Boolean(done));
  const reqs = await roninRequests();
  const last = reqs.proxy[reqs.proxy.length - 1];
  check("H6: healed turn used the delegated key, never the session token",
    Boolean(last) && last.authKind === "delegated" && last.headers.authorization === `Bearer ${FAKE1}`,
    `proxyRequests=${reqs.proxy.length} before=${before}`);
}

// ---------- H5: leakage sweep over everything the tests captured ----------
{
  const st1 = await c1.api("GET", "/api/auth/state");
  const st2 = await c2.api("GET", "/api/auth/state");
  const status1 = await c1.api("GET", "/api/status");
  const payloads = JSON.stringify([st1.json, st2.json, status1.json]);
  check("H5: delegated key absent from GUI-layer state payloads", !payloads.includes(FAKE1));
  check("H5: GUI state still shows the masked form", payloads.includes(`••••${FAKE1.slice(-4)}`));
  const logs = output.host1 + output.host2;
  check("H5: delegated key absent from captured host logs", logs.length > 0 && !logs.includes(FAKE1));
}

host1.proc.kill();
host2.proc.kill();
ronin.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} hard-battery checks passed`);
process.exit(process.exitCode || 0);
