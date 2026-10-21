#!/usr/bin/env node
// Ronin Code — desktop staging script.
//
// Prepares everything Tauri bundles that is NOT committed to git:
//
//   src-tauri/resources/host/   copy of ../host (src/, package.json,
//                               package-lock.json, ENGINE.md, starters/ if
//                               present — never node_modules from the repo)
//                               followed by a production `npm ci` inside it.
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

function stageHost() {
  if (!fs.existsSync(HOST_SRC)) fail(`host directory not found: ${HOST_SRC}`);
  fs.rmSync(HOST_DEST, { recursive: true, force: true });
  fs.mkdirSync(HOST_DEST, { recursive: true });
  for (const item of ["src", "package.json", "package-lock.json", "ENGINE.md", "starters"]) {
    const src = path.join(HOST_SRC, item);
    if (fs.existsSync(src)) copy(src, path.join(HOST_DEST, item), `host/${item}`);
    else if (item !== "starters") fail(`expected host file missing: ${src}`);
  }
  // Belt and braces: never ship a copied node_modules; npm ci recreates it.
  fs.rmSync(path.join(HOST_DEST, "node_modules"), { recursive: true, force: true });

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
