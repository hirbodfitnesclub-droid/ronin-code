// Ronin Code host — unit tests for AuthManager + CredentialStore
// (host/src/auth.js) against a stubbed fetch implementing the Ronin
// server's auth surface: OTP verify, handoff exchange, rotating
// refresh, and account-status. Run: npm --prefix host run test:unit
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RONIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-unit-auth-"));

const { AuthManager, CredentialStore, AuthError, subscriptionKeyFingerprint } = await import("../src/auth.js");
const { buildSubscriptionAttempt, classifyProxyError } = await import("../src/router.js");

// Obvious fake delegated key — never a real value (design §12.3).
const FAKE_KEY = "sk-ronin-FAKE-delegated-key-0001";
const FAKE_KEY_ROTATED = "sk-ronin-FAKE-delegated-key-0002";

const jwt = (expOffsetSec) =>
  `h.${Buffer.from(
    JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + expOffsetSec }),
  ).toString("base64url")}.s`;

function makeStubServer({ ttlSec = 3600 } = {}) {
  const state = {
    counter: 0,
    currentAccess: null,
    currentRefresh: null,
    rotatedOut: new Set(),
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
    accountNetworkDown: false,
    failNextAccountStatus: 0,
    failAllAccountStatus: false,
    // Phase 2 credential endpoint state (design §5.2).
    credential: {
      routingMode: "per_user",
      keyStatus: "active",
      delegatedKey: FAKE_KEY,
      tokenLimitIssued: 20_000_000,
      providerBaseUrl: null,
    },
    credentialHttpStatus: 200,
    credentialError: "account_disabled",
  };
  const calls = { refresh: [], verifyBodies: [], exchangeBodies: [], accountStatus: 0, credential: 0 };

  function issue() {
    if (state.currentRefresh) state.rotatedOut.add(state.currentRefresh);
    state.counter += 1;
    state.currentAccess = jwt(ttlSec);
    state.currentRefresh = `rt-${state.counter}`;
    return {
      accessToken: state.currentAccess,
      refreshToken: state.currentRefresh,
      accessExpiresInSec: ttlSec,
      user: { id: "u1", phone: "09120000000" },
      deviceId: "dev-1",
    };
  }

  const jsonRes = (status, obj) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  });

  const fetchFn = async (url, opts = {}) => {
    const pathname = new URL(url).pathname;
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (pathname === "/api/auth/handoff/exchange") {
      calls.exchangeBodies.push(body);
      if (body.code === "bad-code") return jsonRes(400, { error: "invalid_code" });
      return jsonRes(200, issue());
    }
    if (pathname === "/api/auth/otp/verify") {
      calls.verifyBodies.push(body);
      if (body.code === "000000") return jsonRes(401, { error: "invalid_code" });
      return jsonRes(200, issue());
    }
    if (pathname === "/api/auth/otp/request") {
      if (body.phone === "bad") return jsonRes(429, { error: "rate_limited" });
      return jsonRes(200, { ok: true });
    }
    if (pathname === "/api/auth/refresh") {
      calls.refresh.push(body.refreshToken);
      if (state.rotatedOut.has(body.refreshToken)) return jsonRes(401, { error: "refresh_reuse" });
      if (body.refreshToken !== state.currentRefresh) return jsonRes(401, { error: "invalid_refresh" });
      return jsonRes(200, issue());
    }
    if (pathname === "/api/account-status") {
      calls.accountStatus += 1;
      if (state.accountNetworkDown) throw new TypeError("fetch failed");
      if (state.failAllAccountStatus) return jsonRes(401, { error: "session_revoked" });
      if (state.failNextAccountStatus > 0) {
        state.failNextAccountStatus -= 1;
        return jsonRes(401, { error: "session_revoked" });
      }
      const bearer = (opts.headers?.Authorization || "").replace("Bearer ", "");
      if (bearer !== state.currentAccess) return jsonRes(401, { error: "session_revoked" });
      return jsonRes(200, state.account);
    }
    if (pathname === "/api/subscription/credential") {
      calls.credential += 1;
      const bearer = (opts.headers?.Authorization || "").replace("Bearer ", "");
      if (bearer !== state.currentAccess) return jsonRes(401, { error: "session_revoked" });
      if (state.credentialHttpStatus !== 200) {
        return jsonRes(state.credentialHttpStatus, { error: { code: state.credentialError } });
      }
      const c = state.credential;
      if (c.routingMode === "shared") return jsonRes(200, { routingMode: "shared" });
      const withKey = c.keyStatus === "active" || c.keyStatus === "needs_attention";
      return jsonRes(200, {
        routingMode: "per_user",
        keyStatus: c.keyStatus,
        tokenLimitIssued: c.tokenLimitIssued,
        issuedAt: "2026-10-23T00:00:00.000Z",
        ...(withKey && c.delegatedKey ? { delegatedKey: c.delegatedKey } : {}),
        ...(c.providerBaseUrl ? { providerBaseUrl: c.providerBaseUrl } : {}),
      });
    }
    if (pathname === "/api/auth/logout") {
      if (state.logoutThrows) throw new TypeError("fetch failed");
      return jsonRes(200, { ok: true });
    }
    return jsonRes(404, { error: "not_found" });
  };

  return { state, calls, fetchFn, issue };
}

function makeManager(stub) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-auth-test-"));
  const store = new CredentialStore(path.join(dir, "credentials.json"));
  const manager = new AuthManager({
    store,
    fetchFn: stub.fetchFn,
    serverUrl: "http://ronin.test",
    panelUrl: "http://panel.test",
    deviceName: "Test Device",
  });
  return { manager, store, dir };
}

// ---------------- CredentialStore ----------------

test("auth store: round-trip persists the session shape at mode 0600, clear removes it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-store-"));
  const file = path.join(dir, "credentials.json");
  const store = new CredentialStore(file);
  assert.equal(store.load(), null);
  store.save({
    accessToken: "a1",
    refreshToken: "r1",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
  });
  const loaded = store.load();
  assert.equal(loaded.accessToken, "a1");
  assert.equal(loaded.refreshToken, "r1");
  assert.equal(loaded.deviceId, "dev-1");
  assert.deepEqual(loaded.user, { id: "u1" });
  assert.equal(loaded.serverUrl, "http://ronin.test");
  assert.ok(typeof loaded.savedAt === "string" && loaded.savedAt.length > 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(fs.existsSync(file), false);
});

// ---------------- login flows ----------------

test("auth: exchangeCode persists the session and caches the subscription", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  const { user } = await manager.exchangeCode("good-code");
  assert.equal(user.id, "u1");
  assert.equal(stub.calls.exchangeBodies[0].deviceName, "Test Device");
  const saved = store.load();
  assert.ok(saved && saved.refreshToken === stub.state.currentRefresh);
  const s = manager.state();
  assert.equal(s.loggedIn, true);
  assert.equal(s.user.id, "u1");
  assert.equal(s.subscription.status, "active");
  assert.equal(s.subscription.balanceTokens, 5_000_000);
  assert.equal(s.subscription.deviceAuthorized, true);
  assert.equal(s.subscription.stale, false);
});

test("auth: exchangeCode surfaces the server error status + code", async () => {
  const stub = makeStubServer();
  const { manager } = makeManager(stub);
  await assert.rejects(manager.exchangeCode("bad-code"), (e) => {
    assert.ok(e instanceof AuthError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "invalid_code");
    return true;
  });
  assert.equal(manager.state().loggedIn, false);
});

test("auth: verifyOtp sends the device name and persists the session", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  await manager.verifyOtp("09120000000", "123456");
  assert.equal(stub.calls.verifyBodies[0].deviceName, "Test Device");
  assert.equal(stub.calls.verifyBodies[0].phone, "09120000000");
  assert.ok(store.load());
  assert.equal(manager.state().loggedIn, true);
});

test("auth: requestOtp passes through success and server errors", async () => {
  const stub = makeStubServer();
  const { manager } = makeManager(stub);
  assert.deepEqual(await manager.requestOtp("09120000000"), { ok: true });
  await assert.rejects(manager.requestOtp("bad"), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, "rate_limited");
    return true;
  });
});

// ---------------- refresh ----------------

test("auth: ensureFreshAccess skips refresh while >60s remain, refreshes and persists rotation under 60s", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  // Fresh token: no refresh call.
  stub.state.currentRefresh = "rt-fresh";
  store.save({ accessToken: jwt(3600), refreshToken: "rt-fresh", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
  const tok = await manager.ensureFreshAccess();
  assert.equal(stub.calls.refresh.length, 0);
  assert.ok(tok);
  // Expiring token: refresh fires, rotated pair is persisted.
  stub.state.currentRefresh = "rt-expiring";
  stub.state.rotatedOut.clear();
  store.save({ accessToken: jwt(30), refreshToken: "rt-expiring", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
  const tok2 = await manager.ensureFreshAccess();
  assert.deepEqual(stub.calls.refresh, ["rt-expiring"]);
  assert.equal(tok2, stub.state.currentAccess);
  assert.equal(store.load().refreshToken, stub.state.currentRefresh);
  assert.notEqual(store.load().refreshToken, "rt-expiring");
});

test("auth: refresh reuse (401) clears the session", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  stub.state.currentRefresh = "rt-current";
  stub.state.rotatedOut.add("rt-reused");
  store.save({ accessToken: jwt(30), refreshToken: "rt-reused", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
  const tok = await manager.ensureFreshAccess();
  assert.equal(tok, null);
  assert.equal(store.load(), null);
  assert.equal(manager.state().loggedIn, false);
  assert.equal(manager.subscriptionLocked(), true);
});

// ---------------- revalidate ----------------

test("auth: revalidate keeps the last cache flagged stale on network failure", async () => {
  const stub = makeStubServer();
  const { manager } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(manager.state().subscription.stale, false);
  stub.state.accountNetworkDown = true;
  const sub = await manager.revalidate();
  assert.equal(sub.stale, true);
  assert.equal(sub.status, "active");
  assert.equal(sub.balanceTokens, 5_000_000);
  assert.equal(manager.subscriptionLocked(), false);
});

test("auth: revalidate recovers from a 401 with one refresh + retry", async () => {
  const stub = makeStubServer();
  const { manager } = makeManager(stub);
  await manager.exchangeCode("good-code");
  stub.state.failNextAccountStatus = 1;
  const refreshesBefore = stub.calls.refresh.length;
  const sub = await manager.revalidate();
  assert.equal(sub.status, "active");
  assert.equal(sub.stale, false);
  assert.ok(stub.calls.refresh.length > refreshesBefore);
  assert.equal(manager.state().loggedIn, true);
});

test("auth: revalidate clears the session when 401 persists after refresh", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  stub.state.failAllAccountStatus = true;
  const sub = await manager.revalidate();
  assert.equal(sub, null);
  assert.equal(store.load(), null);
  assert.equal(manager.state().loggedIn, false);
});

// ---------------- subscription lock matrix ----------------

test("auth: subscriptionLocked matrix", async () => {
  // Not logged in → locked.
  {
    const stub = makeStubServer();
    const { manager } = makeManager(stub);
    assert.equal(manager.subscriptionLocked(), true);
  }
  // Logged in, never checked → grace: unlocked (documented choice).
  {
    const stub = makeStubServer();
    const { manager, store } = makeManager(stub);
    store.save({ accessToken: jwt(3600), refreshToken: "rt-x", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
    assert.equal(manager.subscriptionLocked(), false);
  }
  // Active + authorized → unlocked; disabled → locked; unauthorized device → locked.
  {
    const stub = makeStubServer();
    const { manager } = makeManager(stub);
    await manager.exchangeCode("good-code");
    assert.equal(manager.subscriptionLocked(), false);
    stub.state.account = { ...stub.state.account, status: "disabled", isActive: false };
    await manager.revalidate();
    assert.equal(manager.subscriptionLocked(), true);
    stub.state.account = { ...stub.state.account, status: "active", isActive: true, deviceAuthorized: false };
    await manager.revalidate();
    assert.equal(manager.subscriptionLocked(), true);
  }
});

function perUserAccount(stub, { keyStatus = "active", limit = 20_000_000 } = {}) {
  stub.state.account = {
    ...stub.state.account,
    routingMode: "per_user",
    providerKey: { status: keyStatus, tokenLimitIssued: limit, balanceStale: false },
  };
  stub.state.credential = { ...stub.state.credential, keyStatus, tokenLimitIssued: limit };
}

// ---------------- Phase 2: delegated credential (design §5 / §12.3) ----------------

test("credential store: subscriptionKey round-trips as a separate field at mode 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-store-sub-"));
  const file = path.join(dir, "credentials.json");
  const store = new CredentialStore(file);
  store.save({
    accessToken: "a1",
    refreshToken: "r1",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    subscriptionKey: FAKE_KEY,
    subscriptionKeyFingerprint: subscriptionKeyFingerprint(FAKE_KEY),
    subscriptionKeyStatus: "active",
    routingMode: "per_user",
  });
  const loaded = store.load();
  assert.equal(loaded.subscriptionKey, FAKE_KEY);
  assert.equal(loaded.subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY));
  assert.equal(loaded.subscriptionKeyStatus, "active");
  assert.equal(loaded.routingMode, "per_user");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A save without the field clears it (no stale key survives).
  store.save({ accessToken: "a1", refreshToken: "r1", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
  assert.equal(store.load().subscriptionKey, null);
});

test("credential: per-user login fetches and stores the delegated key; GUI state shows only the masked form", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(stub.calls.credential, 1);
  const saved = store.load();
  assert.equal(saved.subscriptionKey, FAKE_KEY);
  assert.equal(saved.subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY));
  assert.equal(saved.subscriptionKeyStatus, "active");
  assert.equal(manager.getSubscriptionKey(), FAKE_KEY);
  assert.equal(manager.subscriptionRoutingMode(), "per_user");
  const st = manager.state();
  assert.equal(st.subscription.routingMode, "per_user");
  assert.equal(st.subscription.providerKey.status, "active");
  assert.equal(st.subscription.subscriptionKeyMasked, "••••" + FAKE_KEY.slice(-4));
  assert.ok(!JSON.stringify(st).includes(FAKE_KEY), "raw key must never reach the GUI state");
  // The delegated key lives only in credentials.json — never auth.json/config.json.
  const dir = path.dirname(store.path);
  for (const name of ["auth.json", "config.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p, "utf8").includes(FAKE_KEY), `${name} must not contain the key`);
  }
});

test("credential: shared mode never fetches and stores nothing (mixed-mode fallback)", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(stub.calls.credential, 0);
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(manager.subscriptionRoutingMode(), "shared");
});

test("credential: server reporting shared during a per-user session clears the key (rollback)", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  stub.state.credential = { ...stub.state.credential, routingMode: "shared" };
  const res = await manager.fetchSubscriptionCredential();
  assert.equal(res.routingMode, "shared");
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(manager.subscriptionRoutingMode(), "shared");
});

test("credential: rotation — a changed limit on revalidate re-fetches and replaces the key by fingerprint", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  const fpBefore = store.load().subscriptionKeyFingerprint;
  // Provider rotates the key and the issued limit grows (top-up).
  stub.state.credential = { ...stub.state.credential, delegatedKey: FAKE_KEY_ROTATED, tokenLimitIssued: 50_000_000 };
  perUserAccount(stub, { limit: 50_000_000 });
  await manager.revalidate();
  assert.equal(store.load().subscriptionKey, FAKE_KEY_ROTATED);
  assert.equal(store.load().subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY_ROTATED));
  assert.notEqual(store.load().subscriptionKeyFingerprint, fpBefore);
});

test("credential: frozen status withholds the key and clears the local copy", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  perUserAccount(stub, { keyStatus: "frozen", limit: 99_000_000 });
  stub.state.credential = { ...stub.state.credential, keyStatus: "frozen", tokenLimitIssued: 99_000_000 };
  await manager.revalidate();
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(manager.getSubscriptionKey(), null);
});

test("credential: keyStatus none clears the stored key on direct fetch", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  stub.state.credential = { ...stub.state.credential, keyStatus: "none", delegatedKey: null };
  const res = await manager.fetchSubscriptionCredential();
  assert.equal(res.keyStatus, "none");
  assert.equal(store.load().subscriptionKey, null);
});

test("credential: account-disabled revalidation clears the stored key", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  stub.state.account = { ...stub.state.account, status: "disabled", isActive: false };
  await manager.revalidate();
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(manager.subscriptionLocked(), true);
});

test("credential: a refused fetch (account_disabled) throws and clears the key", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  stub.state.credentialHttpStatus = 403;
  await assert.rejects(manager.fetchSubscriptionCredential(), (e) => {
    assert.ok(e instanceof AuthError);
    assert.equal(e.code, "account_disabled");
    return true;
  });
  assert.equal(store.load().subscriptionKey, null);
});

test("credential: ensureSubscriptionKey fetches exactly once when absent, then serves the store", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  // Seed a per-user session directly (no login-time fetch yet).
  stub.state.currentRefresh = "rt-seed";
  store.save({
    accessToken: jwt(3600),
    refreshToken: "rt-seed",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    routingMode: "per_user",
  });
  stub.state.currentAccess = store.load().accessToken;
  // The stub validates the credential bearer against its current access.
  const key = await manager.ensureSubscriptionKey();
  assert.equal(key, FAKE_KEY);
  assert.equal(stub.calls.credential, 1);
  assert.equal(await manager.ensureSubscriptionKey(), FAKE_KEY);
  assert.equal(stub.calls.credential, 1);
});

test("credential: account switch never carries the previous user's key; same-user refresh preserves it", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  store.save({
    accessToken: jwt(3600),
    refreshToken: "rt-a",
    deviceId: "dev-1",
    user: { id: "user-a" },
    serverUrl: "http://ronin.test",
    subscriptionKey: FAKE_KEY,
    subscriptionKeyFingerprint: subscriptionKeyFingerprint(FAKE_KEY),
    subscriptionKeyStatus: "active",
    routingMode: "per_user",
  });
  manager._persistSession({ accessToken: jwt(3600), refreshToken: "rt-a2", user: { id: "user-a" } });
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  manager._persistSession({ accessToken: jwt(3600), refreshToken: "rt-b", user: { id: "user-b" } });
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(store.load().routingMode, null);
});

test("credential: logout clears the delegated key with the session", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  await manager.logout();
  assert.equal(store.load(), null);
});

// ---------------- subscription attempt routing (design §5.3 / §12.3) ----------------

test("attempt: per-user mode uses the delegated key, shared mode the session token", async () => {
  // Per-user.
  {
    const stub = makeStubServer();
    perUserAccount(stub);
    const { manager } = makeManager(stub);
    await manager.exchangeCode("good-code");
    const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
    assert.equal(attempt.apiKey, FAKE_KEY);
    assert.equal(attempt.routingMode, "per_user");
    assert.equal(attempt.baseUrl, "http://ronin.test/v1");
    assert.notEqual(attempt.apiKey, stub.state.currentAccess);
  }
  // Shared (v1 regression lock).
  {
    const stub = makeStubServer();
    const { manager } = makeManager(stub);
    await manager.exchangeCode("good-code");
    const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
    assert.equal(attempt.apiKey, stub.state.currentAccess);
    assert.equal(attempt.routingMode, "shared");
  }
});

test("attempt: missing per-user key triggers one credential fetch, then provider_key_not_ready while pending", async () => {
  const stub = makeStubServer();
  perUserAccount(stub, { keyStatus: "pending_create" });
  stub.state.credential = { ...stub.state.credential, keyStatus: "pending_create", delegatedKey: null };
  const { manager } = makeManager(stub);
  await manager.exchangeCode("good-code");
  const callsAfterLogin = stub.calls.credential;
  await assert.rejects(buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" }), (e) => {
    assert.equal(e.code, "provider_key_not_ready");
    return true;
  });
  assert.equal(stub.calls.credential, callsAfterLogin + 1, "exactly one on-demand fetch");
});

test("attempt: a fetchable key is picked up on first subscription use", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  stub.state.currentRefresh = "rt-seed2";
  store.save({
    accessToken: jwt(3600),
    refreshToken: "rt-seed2",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    routingMode: "per_user",
  });
  stub.state.currentAccess = store.load().accessToken;
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.apiKey, FAKE_KEY);
  assert.equal(stub.calls.credential, 1);
});

// ---------------- direct transport: providerBaseUrl (Vercel consolidation) ----------------

const FAKE_PROVIDER_URL = "https://provider.test/v1";

test("direct: credential providerBaseUrl round-trips in the store alongside the key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-store-direct-"));
  const file = path.join(dir, "credentials.json");
  const store = new CredentialStore(file);
  store.save({
    accessToken: "a1",
    refreshToken: "r1",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    subscriptionKey: FAKE_KEY,
    subscriptionKeyFingerprint: subscriptionKeyFingerprint(FAKE_KEY),
    subscriptionKeyStatus: "active",
    routingMode: "per_user",
    providerBaseUrl: FAKE_PROVIDER_URL,
  });
  assert.equal(store.load().providerBaseUrl, FAKE_PROVIDER_URL);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A save without the field clears it with the key (same lifecycle).
  store.save({ accessToken: "a1", refreshToken: "r1", deviceId: "dev-1", user: { id: "u1" }, serverUrl: "http://ronin.test" });
  assert.equal(store.load().providerBaseUrl, null);
});

test("direct: credential fetch persists providerBaseUrl; the attempt goes direct to the provider", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: FAKE_PROVIDER_URL };
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, FAKE_PROVIDER_URL);
  assert.equal(manager.getSubscriptionProviderBaseUrl(), FAKE_PROVIDER_URL);
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.transport, "direct");
  assert.equal(attempt.baseUrl, FAKE_PROVIDER_URL);
  assert.equal(attempt.providerBaseUrl, FAKE_PROVIDER_URL);
  assert.equal(attempt.apiKey, FAKE_KEY);
});

test("direct: a credential without providerBaseUrl falls back to the relay (older server)", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, null);
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.transport, "relay");
  assert.equal(attempt.baseUrl, "http://ronin.test/v1");
  assert.equal(attempt.providerBaseUrl, null);
});

test("direct: config subscriptionTransport 'relay' keeps the relay even with a provider URL", async () => {
  const { config } = await import("../src/config.js");
  const stub = makeStubServer();
  perUserAccount(stub);
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: FAKE_PROVIDER_URL };
  const { manager } = makeManager(stub);
  await manager.exchangeCode("good-code");
  const prev = config.subscriptionTransport;
  config.subscriptionTransport = "relay";
  try {
    const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
    assert.equal(attempt.transport, "relay");
    assert.equal(attempt.baseUrl, "http://ronin.test/v1");
    assert.equal(attempt.apiKey, FAKE_KEY);
  } finally {
    config.subscriptionTransport = prev;
  }
});

test("direct: a stored key without a URL picks the URL up with one credential re-fetch on first use", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, null);
  // Server starts delivering the URL after the key was stored.
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: FAKE_PROVIDER_URL };
  const callsBefore = stub.calls.credential;
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(stub.calls.credential, callsBefore + 1, "exactly one upgrade re-fetch");
  assert.equal(attempt.transport, "direct");
  assert.equal(attempt.baseUrl, FAKE_PROVIDER_URL);
  // Second attempt: URL is now stored, no further fetch.
  const attempt2 = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(stub.calls.credential, callsBefore + 1);
  assert.equal(attempt2.transport, "direct");
});

test("direct: frozen status clears providerBaseUrl together with the key", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: FAKE_PROVIDER_URL };
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, FAKE_PROVIDER_URL);
  perUserAccount(stub, { keyStatus: "frozen", limit: 99_000_000 });
  stub.state.credential = { ...stub.state.credential, keyStatus: "frozen", tokenLimitIssued: 99_000_000 };
  await manager.revalidate();
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(store.load().providerBaseUrl, null);
  assert.equal(manager.getSubscriptionProviderBaseUrl(), null);
});

test("direct: rollback to shared mode clears providerBaseUrl with the key", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: FAKE_PROVIDER_URL };
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, FAKE_PROVIDER_URL);
  stub.state.credential = { ...stub.state.credential, routingMode: "shared" };
  await manager.fetchSubscriptionCredential();
  assert.equal(store.load().subscriptionKey, null);
  assert.equal(store.load().providerBaseUrl, null);
});

test("direct: a malformed providerBaseUrl from the server is ignored (relay fallback, no crash)", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  stub.state.credential = { ...stub.state.credential, providerBaseUrl: "ftp://provider.test/v1" };
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().providerBaseUrl, null);
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.transport, "relay");
  assert.equal(attempt.baseUrl, "http://ronin.test/v1");
});

// ---------------- proxy error classification (design §6.4) ----------------

test("classify: account_suspended maps to the suspended kind, never model_disabled", () => {
  assert.equal(classifyProxyError("403 account_suspended"), "account_suspended");
  assert.equal(classifyProxyError('{"error":{"code":"account_suspended"}}'), "account_suspended");
  assert.equal(classifyProxyError("403 model_disabled"), "model_disabled");
  assert.equal(classifyProxyError("Request failed with status 403"), "model_disabled");
  assert.equal(classifyProxyError("402 insufficient_credit"), "insufficient_credit");
  assert.equal(classifyProxyError("502 provider_key_invalid"), "provider_key_invalid");
  assert.equal(classifyProxyError("503 provider_key_not_ready"), "provider_key_not_ready");
  assert.equal(classifyProxyError("502 provider_forbidden"), "provider_forbidden");
  assert.equal(classifyProxyError("401 session_revoked"), "unauthorized");
});

// ---------------- HARD: security — corruption, leakage, no session-token fallback ----------------

test("hard-sec: fingerprint-mismatched stored key is treated as corrupt — dropped and cleanly re-fetched", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  stub.state.currentRefresh = "rt-corrupt";
  store.save({
    accessToken: jwt(3600),
    refreshToken: "rt-corrupt",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    subscriptionKey: "sk-ronin-FAKE-tampered-9999",
    subscriptionKeyFingerprint: subscriptionKeyFingerprint("sk-ronin-FAKE-some-other-key"),
    subscriptionKeyStatus: "active",
    routingMode: "per_user",
  });
  stub.state.currentAccess = store.load().accessToken;
  assert.equal(manager.getSubscriptionKey(), null, "corrupt key must never be handed out");
  const healed = await manager.ensureSubscriptionKey();
  assert.equal(healed, FAKE_KEY);
  assert.equal(store.load().subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY));
});

test("hard-sec: non-string / malformed credential fields are sanitised, never crash, never leak into attempts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-corrupt-"));
  const file = path.join(dir, "credentials.json");
  // Hand-write a damaged record: key of the wrong type, junk fingerprint.
  fs.writeFileSync(
    file,
    JSON.stringify({
      accessToken: jwt(3600),
      refreshToken: "rt-malformed",
      deviceId: "dev-1",
      user: { id: "u1" },
      serverUrl: "http://ronin.test",
      subscriptionKey: 123456789,
      subscriptionKeyFingerprint: { evil: true },
      routingMode: "per_user",
    }) + "\n",
    { mode: 0o600 },
  );
  const stub = makeStubServer();
  stub.state.currentAccess = JSON.parse(fs.readFileSync(file, "utf8")).accessToken;
  stub.state.currentRefresh = "rt-malformed";
  const store = new CredentialStore(file);
  assert.equal(store.load().subscriptionKey, null);
  const manager = new AuthManager({ store, fetchFn: stub.fetchFn, serverUrl: "http://ronin.test", panelUrl: "http://panel.test", deviceName: "T" });
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.apiKey, FAKE_KEY, "clean re-fetch heals the attempt");
  assert.notEqual(attempt.apiKey, store.load().accessToken);
});

test("hard-sec: fully corrupted credentials file (invalid JSON) loads as no-session, no crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-corrupt2-"));
  const file = path.join(dir, "credentials.json");
  fs.writeFileSync(file, "{not json!! subscriptionKey: sk-ronin-FAKE", { mode: 0o600 });
  const store = new CredentialStore(file);
  assert.equal(store.load(), null);
  const manager = new AuthManager({ store, fetchFn: async () => { throw new Error("unused"); }, serverUrl: "http://ronin.test" });
  assert.equal(manager.state().loggedIn, false);
  assert.equal(manager.subscriptionLocked(), true);
  assert.equal(manager.getSubscriptionKey(), null);
});

test("hard-sec: per-user mode NEVER falls back to the session token when no key can be fetched", async () => {
  const stub = makeStubServer();
  perUserAccount(stub, { keyStatus: "none" });
  stub.state.credential = { ...stub.state.credential, keyStatus: "none", delegatedKey: null };
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, null);
  await assert.rejects(buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" }), (e) => {
    assert.equal(e.code, "provider_key_not_ready");
    return true;
  });
  // Direct resolver check: the session token is never substituted.
  const { SUBSCRIPTION_PROVIDER } = await import("../src/router.js");
  assert.equal(await SUBSCRIPTION_PROVIDER.resolveApiKey(manager), null);
});

test("hard-sec: the delegated key never appears in host log lines or credential return values", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager } = makeManager(stub);
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  let summary;
  try {
    await manager.exchangeCode("good-code");
    summary = await manager.fetchSubscriptionCredential();
    await manager.revalidate();
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
  assert.ok(lines.length > 0, "expected some log lines to inspect");
  for (const line of lines) assert.ok(!line.includes(FAKE_KEY), "log line leaked the delegated key");
  assert.ok(!JSON.stringify(summary).includes(FAKE_KEY), "credential summary leaked the key");
  assert.ok(!JSON.stringify(manager.state()).includes(FAKE_KEY), "GUI state leaked the key");
});

// ---------------- HARD: idempotency — duplicate fetches / logins, rotation signal ----------------

test("hard-idem: concurrent credential fetches are deduped to one server call and one stored key", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  stub.state.currentRefresh = "rt-dedupe";
  store.save({
    accessToken: jwt(3600),
    refreshToken: "rt-dedupe",
    deviceId: "dev-1",
    user: { id: "u1" },
    serverUrl: "http://ronin.test",
    routingMode: "per_user",
  });
  stub.state.currentAccess = store.load().accessToken;
  const [a, b, c] = await Promise.all([
    manager.fetchSubscriptionCredential(),
    manager.fetchSubscriptionCredential(),
    manager.fetchSubscriptionCredential(),
  ]);
  assert.equal(stub.calls.credential, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
});

test("hard-idem: double login does not re-fetch or corrupt the stored key; concurrent revalidates dedupe", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  await manager.exchangeCode("good-code");
  assert.equal(stub.calls.credential, 1, "second login with unchanged key state must not re-fetch");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  assert.equal(store.load().subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY));
  const statusCalls = stub.calls.accountStatus;
  await Promise.all([manager.revalidate(), manager.revalidate(), manager.revalidate()]);
  assert.equal(stub.calls.accountStatus, statusCalls + 1, "concurrent revalidates share one request");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
});

test("hard-idem: stale key is replaced on the re-fetch signal after a server-side rotation", async () => {
  const stub = makeStubServer();
  perUserAccount(stub);
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.equal(store.load().subscriptionKey, FAKE_KEY);
  // Server rotates; the design's re-fetch signal (§5.2c) is an explicit refresh.
  stub.state.credential = { ...stub.state.credential, delegatedKey: FAKE_KEY_ROTATED };
  const before = stub.calls.credential;
  const summary = await manager.refreshSubscriptionCredential();
  assert.equal(stub.calls.credential, before + 1);
  assert.equal(summary.keyStatus, "active");
  assert.equal(store.load().subscriptionKey, FAKE_KEY_ROTATED);
  assert.equal(store.load().subscriptionKeyFingerprint, subscriptionKeyFingerprint(FAKE_KEY_ROTATED));
  const attempt = await buildSubscriptionAttempt(manager, { modelId: "gpt-6-luna" });
  assert.equal(attempt.apiKey, FAKE_KEY_ROTATED);
});

// ---------------- logout ----------------

test("auth: logout clears the session even when the server call fails", async () => {
  const stub = makeStubServer();
  const { manager, store } = makeManager(stub);
  await manager.exchangeCode("good-code");
  assert.ok(store.load());
  stub.state.logoutThrows = true;
  await manager.logout();
  assert.equal(store.load(), null);
  assert.equal(manager.state().loggedIn, false);
  assert.equal(manager.state().subscription, null);
});
