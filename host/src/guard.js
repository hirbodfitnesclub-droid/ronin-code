// Ronin Code — local host service.
// The trust layer: secret redaction, .env protection, the approval
// gate, and the engine extension that enforces all three inside
// every live turn (see ENGINE.md).

import path from "node:path";
import crypto from "node:crypto";
import { config, getProject, loadAuth, keyList } from "./config.js";
import { CREDENTIALS_PATH } from "./paths.js";
import { readJsonFile } from "./util.js";
import { broadcast } from "./sse.js";
import { compressToolText } from "./router.js";

export const SECRET_PATTERNS = [
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g,                 // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                  // Anthropic keys
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,                     // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                 // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,               // Slack tokens
  /\bAKIA[A-Z0-9]{16}\b/g,                           // AWS access keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi,
];

export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) => (p1 ? `${p1}"••••"` : "••••"));
  }
  return out;
}

export function collectSecretValues() {
  const vals = new Set();
  const auth = loadAuth();
  for (const v of Object.values(auth)) for (const k of keyList(v)) if (k.length >= 8) vals.add(k);
  // Phase 2: the delegated subscription key is a spendable secret too —
  // if it ever appears in tool output it must be redacted like any key.
  // Read the credential record directly (no AuthManager import cycle);
  // the value is used only as a redaction needle, never logged.
  try {
    const creds = readJsonFile(CREDENTIALS_PATH, null);
    if (creds && typeof creds.subscriptionKey === "string" && creds.subscriptionKey.length >= 8) {
      vals.add(creds.subscriptionKey);
    }
  } catch {}
  return [...vals];
}

export function redactKnownSecrets(text, values) {
  let out = redactSecrets(text);
  for (const v of values || []) out = out.split(v).join("••••");
  return out;
}

// ---------- .env protection ----------

export function isEnvPath(p, project) {
  if (typeof p !== "string" || !p) return false;
  const abs = path.resolve(project || getProject() || "/", p.startsWith("/") || /^[a-zA-Z]:/.test(p) ? p : path.join(project || "", p));
  const base = path.basename(abs);
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") return false;
  return base === ".env" || base.startsWith(".env.");
}

export function envAccessAllowed(project = getProject()) {
  return project ? config.envAllowedProjects[path.resolve(project)] === true : false;
}

// ---------- approvals ----------

export const pendingApprovals = new Map(); // id -> { resolve, kind, detail }

export function requestApproval(kind, detail) {
  const id = crypto.randomUUID();
  broadcast({ type: "approval_request", approvalId: id, kind, detail });
  return new Promise((resolve) => {
    pendingApprovals.set(id, { resolve });
    // Safety valve: never hang a turn forever.
    setTimeout(() => {
      if (pendingApprovals.delete(id)) resolve(false);
    }, 10 * 60 * 1000);
  });
}

export function resolveApproval(id, approved) {
  const p = pendingApprovals.get(id);
  if (!p) return false;
  pendingApprovals.delete(id);
  broadcast({ type: "approval_resolved", approvalId: id, approved });
  p.resolve(approved);
  return true;
}

// ---------- turns ----------

export function makeGuardExtension({ project, autoMode, secretValues }) {
  const insideProject = (abs) => {
    const rel = path.relative(path.resolve(project), abs);
    return rel === "" || (!rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  };
  const resolveArgPath = (p) =>
    typeof p === "string" && p ? path.resolve(project, p) : null;
  const envBlockedReason =
    "Blocked by Ronin Code: .env files are protected because they usually hold secrets. " +
    "If the user truly needs this, they can enable .env access for this project in Settings. Continue without it.";
  const bashTouchesEnv = (cmd) =>
    /(^|[\s;|&])(?:cat|less|more|head|tail|cp|mv|rm|source|\.|grep|sed|awk|tee)\s+[^|&;]*\.env(\.|\s|$|["'])/.test(cmd) &&
    !/\.env\.(example|sample|template)/.test(cmd);

  return (pi) => {
    pi.on("tool_call", async (event) => {
      const tool = event.toolName;
      const input = event.input || {};
      // --- .env protection (reads, writes, searches, shell) ---
      if (!envAccessAllowed(project)) {
        if ((tool === "read" || tool === "write" || tool === "edit") && isEnvPath(input.path, project)) {
          return { block: true, reason: envBlockedReason };
        }
        if ((tool === "grep" || tool === "find" || tool === "ls") && input.path && isEnvPath(input.path, project)) {
          return { block: true, reason: envBlockedReason };
        }
        if ((tool === "bash" || tool === "powershell") && typeof input.command === "string" && bashTouchesEnv(input.command)) {
          return { block: true, reason: envBlockedReason };
        }
      }
      // --- approval gate ---
      if (autoMode) return undefined;
      if (tool === "bash" || tool === "powershell") {
        const ok = await requestApproval("command", {
          tool,
          command: String(input.command || "").slice(0, 600),
          project,
        });
        if (!ok) return { block: true, reason: "The user declined this command in Ronin Code. Continue without running it, or ask what they would prefer." };
      } else if (tool === "write" || tool === "edit") {
        const abs = resolveArgPath(input.path);
        if (abs && !insideProject(abs)) {
          const ok = await requestApproval("write_outside", { tool, path: abs, project });
          if (!ok) return { block: true, reason: "The user declined writing outside the project in Ronin Code. Keep changes inside the project folder." };
        }
      }
      return undefined;
    });

    pi.on("tool_result", async (event) => {
      if (!["bash", "powershell", "read", "grep", "find", "ls"].includes(event.toolName)) return undefined;
      if (!Array.isArray(event.content)) return undefined;
      let changed = false;
      const content = event.content.map((part) => {
        if (!part || part.type !== "text" || typeof part.text !== "string") return part;
        let text = redactKnownSecrets(part.text, secretValues);
        text = compressToolText(text).text;
        if (text !== part.text) changed = true;
        return { ...part, text };
      });
      return changed ? { content } : undefined;
    });
  };
}

/** One live attempt against one provider+key. Throws on engine/provider failure. */
