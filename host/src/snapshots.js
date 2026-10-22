// Ronin Code — local host service.
// Project snapshots, the pre-turn "latest" tree, and named checkpoints.
// Undo, the changes card and the diff view all read from here.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { SNAPSHOTS_DIR } from "./paths.js";
import { readJsonFile } from "./util.js";

export const SKIP_DIRS = new Set(["node_modules", ".git"]);

export const MAX_FILE = 5 * 1024 * 1024;

export const MAX_FILES = 2000;

export function projectHash(project) {
  return crypto.createHash("sha256").update(path.resolve(project)).digest("hex").slice(0, 16);
}

export async function walkProject(project) {
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

export async function takeSnapshot(project) {
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

export async function readManifest(project) {
  try {
    return JSON.parse(await fsp.readFile(path.join(SNAPSHOTS_DIR, projectHash(project), "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function diffAgainstManifest(project, manifest) {
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

export function checkpointsBase(project) {
  return path.join(SNAPSHOTS_DIR, projectHash(project), "checkpoints");
}

export function checkpointsMetaPath(project) {
  return path.join(SNAPSHOTS_DIR, projectHash(project), "checkpoints.json");
}

export function listCheckpoints(project) {
  const list = readJsonFile(checkpointsMetaPath(project), []);
  return Array.isArray(list) ? list : [];
}

export async function createCheckpoint(project, name) {
  const manifest = await takeSnapshot(project); // refreshes "latest"
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(checkpointsBase(project), id);
  const latest = path.join(SNAPSHOTS_DIR, projectHash(project), "latest");
  await fsp.mkdir(checkpointsBase(project), { recursive: true });
  await fsp.cp(latest, dir, { recursive: true });
  const meta = { id, name: name || new Date().toLocaleString(), ts: new Date().toISOString(), files: manifest.files.length };
  const list = listCheckpoints(project);
  list.unshift(meta);
  await fsp.writeFile(checkpointsMetaPath(project), JSON.stringify(list.slice(0, 50), null, 2));
  return meta;
}

export async function restoreTree(project, sourceDir, manifest) {
  const keep = new Set(manifest.files.map((f) => f.path));
  const now = await walkProject(project);
  for (const f of now) {
    if (!keep.has(f.path)) await fsp.rm(path.join(project, f.path), { force: true });
  }
  for (const f of manifest.files) {
    const dest = path.join(project, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(sourceDir, f.path), dest);
  }
}

// ---------- unified diff ----------
