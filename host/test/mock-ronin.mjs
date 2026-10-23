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
//   GET  /api/subscription/credential  -> Phase 2 delegated-key delivery
//                                         (design §5.2): session-authed;
//                                         shared -> no key material,
//                                         per_user -> the fake key
//   POST /v1/chat/completions          -> relay: records headers/body,
//                                         replies with an SSE text
//                                         completion + usage (or a
//                                         control-set error such as
//                                         402). Dual-auth (§6.2): in
//                                         per-user mode the delegated
//                                         key OR a session token is
//                                         accepted; a stale fake key
//                                         gets 401 provider_key_invalid
// Test controls:
//   POST /__control { account?, proxyMode?, tokenTtlSec?, routingMode?,
//                     credentialKey?, credentialKeyStatus? }
//   GET  /__requests -> { proxy, refreshSeen, accountStatusAuth, credentialFetches }
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
  // Phase 2 per-user key state. Obvious fakes only.
  routingMode: "shared",
  credentialKey: "sk-ronin-FAKE-e2e-key-0001",
  credentialKeyStatus: "active",
  credentialFetches: 0,
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

/** Streaming response shaped by state.proxyMode (hard battery §1):
 *  default -> one-shot completion; "slow" -> chunked over ~1.5s;
 *  "402-midstream" -> partial content, then an SSE error frame
 *  carrying insufficient_credit, then close; "hang-close" -> headers,
 *  silence, then the socket is destroyed early. */
function respondStream(res) {
  const mode = state.proxyMode;
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 9)}`;
  const base = { id, object: "chat.completion.chunk", created: 1700000000, model: "stub" };
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (mode === "hang-close") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    setTimeout(() => { try { res.destroy(); } catch {} }, 400);
    return;
  }
  if (mode === "402-midstream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Partial reply " }, finish_reason: null }] });
    setTimeout(() => {
      try {
        sseChunk(res, { ...base, choices: [], error: { code: "insufficient_credit", message: "402 insufficient_credit" } });
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {}
    }, 250);
    return;
  }
  if (mode === "slow") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let i = 0;
    const timer = setInterval(() => {
      try {
        i += 1;
        if (i <= 5) {
          sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Slow reply. " }, finish_reason: null }] });
        } else {
          clearInterval(timer);
          sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } catch { clearInterval(timer); }
    }, 250);
    return;
  }
  return sendText(res, "Subscription reply.");
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
    if (body.routingMode === "per_user" || body.routingMode === "shared") state.routingMode = body.routingMode;
    if (typeof body.credentialKey === "string") state.credentialKey = body.credentialKey;
    if (typeof body.credentialKeyStatus === "string") state.credentialKeyStatus = body.credentialKeyStatus;
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/__requests" && req.method === "GET") {
    return sendJson(res, 200, { proxy: proxyRequests, refreshSeen, accountStatusAuth, credentialFetches: state.credentialFetches });
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
    return sendJson(res, 200, {
      ...state.account,
      routingMode: state.routingMode,
      ...(state.routingMode === "per_user"
        ? {
            providerKey: {
              status: state.credentialKeyStatus,
              tokenLimitIssued: 20_000_000,
              balanceStale: false,
            },
          }
        : {}),
    });
  }
  if (pathname === "/api/subscription/credential" && req.method === "GET") {
    state.credentialFetches += 1;
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    if (state.revoked || !state.validAccess.has(bearer)) {
      return sendJson(res, 401, { error: "session_revoked" });
    }
    if (state.account.status !== "active" || state.account.isActive !== true) {
      return sendJson(res, 403, { error: { code: "account_disabled" } });
    }
    if (state.routingMode === "shared") return sendJson(res, 200, { routingMode: "shared" });
    const withKey = state.credentialKeyStatus === "active" || state.credentialKeyStatus === "needs_attention";
    return sendJson(res, 200, {
      routingMode: "per_user",
      keyStatus: state.credentialKeyStatus,
      tokenLimitIssued: 20_000_000,
      issuedAt: "2026-10-23T00:00:00.000Z",
      ...(withKey ? { delegatedKey: state.credentialKey } : {}),
    });
  }
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    const body = await readBody(req);
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    const authKind =
      state.routingMode === "per_user" && bearer === state.credentialKey
        ? "delegated"
        : state.validAccess.has(bearer)
          ? "session"
          : "none";
    proxyRequests.push({ at: Date.now(), headers: req.headers, body, authKind });
    if (state.proxyMode === "402") return sendJson(res, 402, { error: "insufficient_credit" });
    if (state.proxyMode === "401") return sendJson(res, 401, { error: "session_revoked" });
    if (state.proxyMode === "suspended") return sendJson(res, 403, { error: "account_suspended" });
    if (state.routingMode === "per_user") {
      // Dual-auth (§6.2): delegated key or session token. A fake-shaped
      // but unknown key is a stale key -> provider_key_invalid (401).
      if (bearer === state.credentialKey) {
        if (state.credentialKeyStatus === "frozen") {
          return sendJson(res, 403, { error: "account_suspended" });
        }
        return respondStream(res);
      }
      if (bearer.startsWith("sk-ronin-FAKE")) {
        return sendJson(res, 401, { error: "provider_key_invalid" });
      }
    }
    if (state.revoked || !state.validAccess.has(bearer)) {
      return sendJson(res, 401, { error: "session_revoked" });
    }
    return respondStream(res);
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub ronin server listening on http://127.0.0.1:${PORT}`);
});
