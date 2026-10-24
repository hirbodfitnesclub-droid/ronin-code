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

/**
 * True when a text IS (or, after a short status/prefix, contains) a
 * raw HTML document — e.g. a provider/gateway error page or a fetched
 * 404 page. Such payloads are data for the engine, never prose for
 * the user: error strings and assistant replies must not carry them
 * into the chat. A fenced code sample is intentional content, not a
 * payload, so a leading ``` fence opts out.
 */
export function looksLikeRawHtml(text) {
  if (typeof text !== "string" || !text) return false;
  const head = text.trimStart();
  if (head.startsWith("```")) return false;
  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head)) return true;
  // A document marker shortly after a short prefix ("404: <!DOCTYPE…",
  // "Request failed … <html …>…</html>") is still a raw page dump.
  const marker = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (marker > 0 && marker < 200) {
    const tags = text.match(/<[^>]+>/g);
    if (tags && tags.length >= 3) return true;
  }
  return false;
}

export function cleanError(err) {
  let msg = (err && err.message) || String(err || "Unknown error");
  // A raw HTML error page (a gateway/provider 404 page is the known
  // case) must never reach the user verbatim — keep only its HTTP
  // status, which the proxy classifier and failover checks key off.
  if (looksLikeRawHtml(msg)) {
    const status = (msg.match(/\b([45]\d{2})\b/) || [])[1];
    msg = status
      ? `The provider returned an error (${status}). Please try again.`
      : "The provider returned an error page instead of a reply. Please try again.";
  }
  // Never surface internal engine branding/names to the user.
  msg = msg.replace(/@earendil-works\/[a-z-]+/gi, "Ronin Code engine");
  msg = msg.replace(/\bpi-coding-agent\b/gi, "Ronin Code engine");
  return msg.slice(0, 500);
}
