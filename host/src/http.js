// Ronin Code — local host service.
// HTTP plumbing: the per-run session token, content types, body
// reading, host/token checks and path safety. No routing here.

import path from "node:path";
import crypto from "node:crypto";

export const TOKEN = crypto.randomBytes(24).toString("hex");

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return false;
  // host may be "name", "name:port", "[::1]" or "[::1]:port"
  let h;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    h = host.slice(0, end + 1);
  } else {
    h = host.split(":")[0];
  }
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export function tokenOk(req, url) {
  return req.headers["x-ronin-token"] === TOKEN || url.searchParams.get("token") === TOKEN;
}

export function safeJoin(base, rel) {
  const target = path.resolve(base, "." + path.sep + rel);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

// ---------- provider key test ----------
