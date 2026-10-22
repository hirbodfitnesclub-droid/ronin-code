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

const { AuthManager, CredentialStore, AuthError } = await import("../src/auth.js");

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
  };
  const calls = { refresh: [], verifyBodies: [], exchangeBodies: [], accountStatus: 0 };

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
