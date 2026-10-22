import { log } from "./log.js";
// Ronin Code — local host service.
// Transport: static GUI serving, the live project preview, the
// request gate (host + token), and the listener itself.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { GUI_DIST, VERSION, RONIN_HOME } from "./paths.js";
import { cleanError } from "./util.js";
import { config, getProject, loadAuth, currentModel } from "./config.js";
import { handleApi } from "./routes.js";
import { TOKEN, mimeFor, sendJson, sendText, hostAllowed, tokenOk, safeJoin } from "./http.js";

const PORT = Number(process.env.PORT || 7331);

export async function serveStatic(req, res, url) {
  if (url.pathname === "/ronin-config.js") {
    return sendText(res, 200, `window.__RONIN_TOKEN__=${JSON.stringify(TOKEN)};\n`, "text/javascript; charset=utf-8");
  }
  if (!fs.existsSync(GUI_DIST)) {
    return sendText(res, 200, "Ronin Code is running, but the interface hasn't been built yet. Build the GUI, then refresh this page.");
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  let target = safeJoin(GUI_DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(GUI_DIST, "index.html"); // SPA fallback
  }
  try {
    let data = await fsp.readFile(target);
    if (target.endsWith("index.html")) {
      data = Buffer.from(data.toString("utf8").split("__RONIN_TOKEN__").join(TOKEN), "utf8");
    }
    res.writeHead(200, { "Content-Type": mimeFor(target), "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

export async function servePreview(req, res, url) {
  if (!getProject()) {
    // Dark, on-brand placeholder — never a stark white pane.
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ronin Code</title><style>
      html,body{height:100%;margin:0}body{background:#0b0c10;color:#626a77;display:grid;place-items:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif}
      .c{text-align:center}.r{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;
      border:2px solid rgba(229,72,77,.5);border-top-color:transparent;transform:rotate(-38deg)}
      p{margin:0;font-size:13px;letter-spacing:.02em}</style></head>
      <body><div class="c"><div class="r"></div><p>Your project preview will appear here</p></div></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    return res.end(html);
  }
  let rel = decodeURIComponent(url.pathname.slice("/preview".length)) || "/";
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";
  const target = safeJoin(path.resolve(getProject()), rel);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    if (rel.endsWith("index.html")) {
      // Project is open but has no page yet — keep the branded placeholder
      // instead of a bare 404 while the agent creates the first files.
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ronin Code</title><style>
        html,body{height:100%;margin:0}body{background:#0b0c10;color:#626a77;display:grid;place-items:center;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif}
        .c{text-align:center}.r{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;
        border:2px solid rgba(229,72,77,.5);border-top-color:transparent;transform:rotate(-38deg)}
        p{margin:0;font-size:13px;letter-spacing:.02em}</style></head>
        <body><div class="c"><div class="r"></div><p>Your creation will appear here</p></div></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }
    return sendText(res, 404, "Not found");
  }
  const data = await fsp.readFile(target);
  res.writeHead(200, { "Content-Type": mimeFor(target), "Content-Length": data.length });
  res.end(data);
}

export function startHost() {
  const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return sendJson(res, 403, { error: "Forbidden host" });
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, name: "Ronin Code", version: VERSION });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOk(req, url)) return sendJson(res, 401, { error: "Missing or invalid Ronin Code token" });
      return await handleApi(req, res, url);
    }
    if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
      return await servePreview(req, res, url);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(req, res, url);
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    log.error("request_error", { error: cleanError(e) });
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Please try again." });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log.info("host_listening", { url: `http://127.0.0.1:${PORT}` });
  log.info("host_starting", { dataDir: RONIN_HOME });
  log.info("host_mode", { mode: loadAuth()[config.provider] ? "live" : "preview", provider: config.provider, model: currentModel() });
});
  return server;
}
