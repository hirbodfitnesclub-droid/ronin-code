// Ronin Code — local host service.
// Small shared helpers (no state, no I/O policy).

import fs from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile0600(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function cleanError(err) {
  let msg = (err && err.message) || String(err || "Unknown error");
  // Never surface internal engine branding/names to the user.
  msg = msg.replace(/@earendil-works\/[a-z-]+/gi, "Ronin Code engine");
  msg = msg.replace(/\bpi-coding-agent\b/gi, "Ronin Code engine");
  return msg.slice(0, 500);
}
