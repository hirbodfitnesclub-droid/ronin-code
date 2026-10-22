// Stub Ronin account server for host E2E tests. Implements just the
// surface the host talks to:
//   POST /api/auth/otp/request        -> { ok: true }
//   POST /api/auth/otp/verify          -> session (rotating tokens)
//   POST /api/auth/handoff/exchange    -> session (code "bad" fails)
//   POST /api/auth/refresh             -> rotated pair; reuse of a
//                                         rotated token revokes the
//                                         device (401 refresh_reuse)
//   POST /api/auth/logout              -> { ok: true }
//   GET  /api/account-status           -> mutable account object
//   POST /v1/chat/completions          -> metering proxy: records
//                                         headers/body, replies with
//                                         an SSE text completion +
//                                         usage (or a control-set
//                                         error such as 402)
// Test controls:
//   POST /__control { account?, proxyMode?, tokenTtlSec? }
//   GET  /__requests -> { proxy, refreshSeen, accountStatusAuth }
//   GET  /__state    -> { currentRefresh, refreshSeen }

import http from "node:http";

const PORT = Number(process.env.RONIN_STUB_PORT || 7412);

const state = {
  counter: 0,
  currentAccess: null,
  currentRefresh: null,
  rotatedOut: new Set(),
  validAccess: new Set(),
  revoked: false,
  tokenTtlSec: 3600,
  proxyMode: "ok",
  account: {
    status: "active",
    isActive: true,
    balanceTokens: 5_000_000,
    spendableTokens: 5_000_000,
    deviceAuthorized: true,
    activeDevices: 1,
    serverTime: "2026-10-22T00:00:00.000Z",
    lots: [],
  },
};

export const proxyRequests = [];
export const refreshSeen = [];
export const accountStatusAuth = [];

const jwt = (expOffsetSec) =>
  `h.${Buffer.from(
    JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + expOffsetSec }),
  ).toString("base64url")}.s`;

function issue() {
  if (state.currentRefresh) state.rotatedOut.add(state.currentRefresh);
  state.counter += 1;
  state.currentAccess = jwt(state.tokenTtlSec);
  state.currentRefresh = `rt-${state.counter}`;
  state.validAccess.add(state.currentAccess);
  state.revoked = false;
  return {
    accessToken: state.currentAccess,
    refreshToken: state.currentRefresh,
    accessExpiresInSec: state.tokenTtlSec,
    user: { id: "u1", phone: "09120000000", name: "E2E User" },
    deviceId: "dev-1",
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sendText(res, text, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 9)}`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const base = { id, object: "chat.completion.chunk", created: 1700000000, model: "stub" };
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
  sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/__control" && req.method === "POST") {
    const body = await readBody(req);
    if (body.account && typeof body.account === "object") Object.assign(state.account, body.account);
    if (typeof body.proxyMode === "string") state.proxyMode = body.proxyMode;
    if (typeof body.tokenTtlSec === "number") state.tokenTtlSec = body.tokenTtlSec;
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/__requests" && req.method === "GET") {
    return sendJson(res, 200, { proxy: proxyRequests, refreshSeen, accountStatusAuth });
  }
  if (pathname === "/__state" && req.method === "GET") {
    return sendJson(res, 200, { currentRefresh: state.currentRefresh, currentAccess: state.currentAccess, refreshSeen });
  }

  if (pathname === "/api/auth/otp/request" && req.method === "POST") {
    await readBody(req);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/api/auth/otp/verify" && req.method === "POST") {
    const body = await readBody(req);
    if (body.code === "000000") return sendJson(res, 401, { error: "invalid_code" });
    return sendJson(res, 200, issue());
  }
  if (pathname === "/api/auth/handoff/exchange" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.code || body.code === "bad") return sendJson(res, 400, { error: "invalid_code" });
    return sendJson(res, 200, issue());
  }
  if (pathname === "/api/auth/refresh" && req.method === "POST") {
    const body = await readBody(req);
    refreshSeen.push(body.refreshToken);
    if (state.rotatedOut.has(body.refreshToken)) {
      // Reuse of a rotated token revokes the device outright.
      state.revoked = true;
      state.validAccess.clear();
      return sendJson(res, 401, { error: "refresh_reuse" });
    }
    if (body.refreshToken !== state.currentRefresh) {
      return sendJson(res, 401, { error: "invalid_refresh" });
    }
    return sendJson(res, 200, issue());
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    await readBody(req);
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    state.validAccess.delete(bearer);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/api/account-status" && req.method === "GET") {
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    accountStatusAuth.push(bearer);
    if (state.revoked || !state.validAccess.has(bearer)) {
      return sendJson(res, 401, { error: "session_revoked" });
    }
    return sendJson(res, 200, state.account);
  }
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    const body = await readBody(req);
    proxyRequests.push({ at: Date.now(), headers: req.headers, body });
    if (state.proxyMode === "402") return sendJson(res, 402, { error: "insufficient_credit" });
    if (state.proxyMode === "401") return sendJson(res, 401, { error: "session_revoked" });
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    if (state.revoked || !state.validAccess.has(bearer)) {
      return sendJson(res, 401, { error: "session_revoked" });
    }
    return sendText(res, "Subscription reply.");
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub ronin server listening on http://127.0.0.1:${PORT}`);
});
