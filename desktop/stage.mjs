#!/usr/bin/env node
// Ronin Code — desktop staging script.
//
// Prepares everything Tauri bundles that is NOT committed to git:
//
//   src-tauri/resources/host/   copy of ../host (src/, package.json,
//                               package-lock.json, ENGINE.md, starters/ if
//                               present — never node_modules from the repo)
//                               plus a config.json carrying the production
//                               roninServerUrl / panelUrl (merged into any
//                               previously staged settings), followed by a
//                               production `npm ci` inside it.
//   src-tauri/resources/gui/    copy of ../gui/dist. This sibling layout is
//                               required: the host resolves the GUI as
//                               <host>/../gui/dist, so in the installed app
//                               resources/host and resources/gui must sit
//                               side by side.
//   src-tauri/binaries/         (--node-win only) the Windows Node runtime.
//
// Usage:
//   node desktop/stage.mjs                stage host + gui, install host deps
//   node desktop/stage.mjs --host-only    same, explicitly WITHOUT downloading
//                                         Node (CI downloads node.exe itself
//                                         before calling this — use this flag)
//   node desktop/stage.mjs --node-win     also download Windows Node (below)
//   node desktop/stage.mjs --skip-install stage files only, no `npm ci`
//
// Pinned Node for Windows: v22.14.0 — keep in sync with windows-build.yml.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const RESOURCES = path.join(DESKTOP_DIR, "src-tauri", "resources");
const HOST_SRC = path.join(REPO_ROOT, "host");
const HOST_DEST = path.join(RESOURCES, "host");
const GUI_DIST_SRC = path.join(REPO_ROOT, "gui", "dist");
const GUI_DEST = path.join(RESOURCES, "gui", "dist");
const BINARIES = path.join(DESKTOP_DIR, "src-tauri", "binaries");
const NODE_VERSION = "22.14.0";
const NODE_WIN_URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
const NODE_WIN_DEST = path.join(BINARIES, "node-x86_64-pc-windows-msvc.exe");

const args = new Set(process.argv.slice(2));
const hostOnly = args.has("--host-only");
const withNodeWin = args.has("--node-win") && !hostOnly;
const skipInstall = args.has("--skip-install");

// Production account endpoints for the shipped app. Written into the
// STAGED host's config file (see stageProductionConfig) — the repo
// host keeps its localhost defaults.
const PRODUCTION_RONIN_SERVER_URL = "https://ronin-user-panel.vercel.app";
const PRODUCTION_PANEL_URL = "https://ronin-user-panel.vercel.app";

function fail(msg) {
  console.error(`stage: ERROR — ${msg}`);
  process.exit(1);
}
function copy(src, dest, label) {
  if (!fs.existsSync(src)) fail(`${label} not found: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`stage: copied ${label} -> ${path.relative(REPO_ROOT, dest)}`);
}

function readJsonIfPresent(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Production defaults for the staged host.
//
// The host loads its config from <RONIN_HOME>/config.json (user data)
// and falls back, for roninServerUrl / panelUrl, to a bundled
// config.json in the host root — host/src/config.js loadConfig() /
// loadBundledDefaults(), same JSON object format, same key names.
// Writing the production endpoints THERE (and only there) is what
// makes the installed app talk to production out of the box while the
// repo host/ keeps its localhost defaults; a user's own saved config
// still wins over the bundled file.
//
// Merge, never clobber: settings already present in a staged
// config.json (from a previous stage or a copied host config) are
// preserved; only the two production keys are (re)written.
function stageProductionConfig(priorStaged = {}) {
  const dest = path.join(HOST_DEST, "config.json");
  const merged = {
    ...priorStaged,
    ...readJsonIfPresent(dest),
    roninServerUrl: PRODUCTION_RONIN_SERVER_URL,
    panelUrl: PRODUCTION_PANEL_URL,
  };
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(dest, 0o600); } catch {}
  console.log(`stage: wrote production config -> ${path.relative(REPO_ROOT, dest)}`);
}

function stageHost() {
  if (!fs.existsSync(HOST_SRC)) fail(`host directory not found: ${HOST_SRC}`);
  // Capture any previously staged config BEFORE wiping the tree, so
  // stageProductionConfig can merge into it instead of clobbering.
  const priorStagedConfig = readJsonIfPresent(path.join(HOST_DEST, "config.json"));
  fs.rmSync(HOST_DEST, { recursive: true, force: true });
  fs.mkdirSync(HOST_DEST, { recursive: true });
  for (const item of ["src", "package.json", "package-lock.json", "ENGINE.md", "starters"]) {
    const src = path.join(HOST_SRC, item);
    if (fs.existsSync(src)) copy(src, path.join(HOST_DEST, item), `host/${item}`);
    else if (item !== "starters") fail(`expected host file missing: ${src}`);
  }
  // Belt and braces: never ship a copied node_modules; npm ci recreates it.
  fs.rmSync(path.join(HOST_DEST, "node_modules"), { recursive: true, force: true });
  stageProductionConfig(priorStagedConfig);

  if (skipInstall) {
    console.log("stage: --skip-install set, skipping host `npm ci`");
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log("stage: installing host production dependencies (npm ci --omit=dev)…");
  const res = spawnSync(npm, ["ci", "--omit=dev", "--prefix", HOST_DEST], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) fail("host `npm ci` failed — see output above");
}

function stageGui() {
  if (!fs.existsSync(path.join(GUI_DIST_SRC, "index.html"))) {
    fail(`GUI build not found at ${GUI_DIST_SRC} — run \`npm run build\` at the repo root first`);
  }
  fs.rmSync(path.join(RESOURCES, "gui"), { recursive: true, force: true });
  copy(GUI_DIST_SRC, GUI_DEST, "gui/dist");
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(res.headers.location, dest, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

async function stageNodeWin() {
  console.log(`stage: downloading Node v${NODE_VERSION} (win-x64)…`);
  await download(NODE_WIN_URL, NODE_WIN_DEST);
  const { size } = fs.statSync(NODE_WIN_DEST);
  if (size < 10 * 1024 * 1024) fail(`downloaded node.exe looks too small (${size} bytes)`);
  console.log(`stage: Node runtime staged (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

stageHost();
stageGui();
if (withNodeWin) {
  await stageNodeWin();
} else {
  console.log(
    hostOnly
      ? "stage: --host-only — skipping Node download (caller provides src-tauri/binaries/node*)"
      : "stage: skipping Node download (pass --node-win to fetch the Windows runtime)",
  );
}
console.log("stage: done");
