// Ronin Code — local host service.
// Account session management for the Ronin subscription server:
// OTP / handoff-code login, refresh-token rotation, and the cached
// account status that gates subscription turns.
//
// Credential storage: CredentialStore below persists the session as
// JSON in the host data dir (credentials.json, file mode 0600). The
// Tauri shell will swap this class for the OS credential store
// (Windows Credential Manager) behind the same load/save/clear
// interface — AuthManager only ever talks to that interface, never
// to the file directly, and tokens never land in config.json,
// localStorage, or the GUI.

import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { CREDENTIALS_PATH } from "./paths.js";
import { readJsonFile, writeJsonFile0600 } from "./util.js";
import { config, maskedKey } from "./config.js";
import { log } from "./log.js";

/** SHA-256 hex fingerprint of a delegated subscription key. Used only
 *  for change detection (rotation / replacement) and diagnostics —
 *  never the key itself, and a hash cannot be turned back into a
 *  spendable key (design §5.3). */
export function subscriptionKeyFingerprint(key) {
  if (typeof key !== "string" || !key) return null;
  return crypto.createHash("sha256").update(key).digest("hex");
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:7443";
export const DEFAULT_PANEL_URL = "http://127.0.0.1:5173";

// Refresh responses with any of these codes mean the session is dead
// (rotated-token reuse revokes the device server-side). Any 401 from
// the refresh endpoint clears the local session.
export const REFRESH_FATAL_CODES = new Set([
  "refresh_reuse",
  "session_revoked",
  "invalid_refresh",
  "refresh_expired",
]);

export class AuthError extends Error {
  constructor(status, code) {
    super(code || `auth request failed (${status})`);
    this.name = "AuthError";
    this.status = status;
    this.code = code || "auth_error";
  }
}

export class CredentialStore {
  constructor(filePath = CREDENTIALS_PATH) {
    this.path = filePath;
  }

  load() {
    const s = readJsonFile(this.path, null);
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    if (typeof s.accessToken !== "string" || !s.accessToken) return null;
    if (typeof s.refreshToken !== "string" || !s.refreshToken) return null;
    return {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      deviceId: typeof s.deviceId === "string" ? s.deviceId : null,
      user: s.user && typeof s.user === "object" ? s.user : null,
      serverUrl: typeof s.serverUrl === "string" ? s.serverUrl : null,
      savedAt: typeof s.savedAt === "string" ? s.savedAt : null,
      // Phase 2 (design §5.3): the user's own delegated provider key,
      // kept as a SEPARATE field of this record — never in auth.json
      // (BYOK keys) or config.json, never sent to the GUI in raw form.
      subscriptionKey: typeof s.subscriptionKey === "string" && s.subscriptionKey ? s.subscriptionKey : null,
      subscriptionKeyFingerprint:
        typeof s.subscriptionKeyFingerprint === "string" && s.subscriptionKeyFingerprint
          ? s.subscriptionKeyFingerprint
          : null,
      subscriptionKeyStatus:
        typeof s.subscriptionKeyStatus === "string" && s.subscriptionKeyStatus ? s.subscriptionKeyStatus : null,
      routingMode: s.routingMode === "per_user" || s.routingMode === "shared" ? s.routingMode : null,
    };
  }

  save(session) {
    writeJsonFile0600(this.path, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      deviceId: session.deviceId ?? null,
      user: session.user ?? null,
      serverUrl: session.serverUrl ?? null,
      savedAt: new Date().toISOString(),
      subscriptionKey: typeof session.subscriptionKey === "string" && session.subscriptionKey ? session.subscriptionKey : null,
      subscriptionKeyFingerprint:
        typeof session.subscriptionKeyFingerprint === "string" && session.subscriptionKeyFingerprint
          ? session.subscriptionKeyFingerprint
          : null,
      subscriptionKeyStatus:
        typeof session.subscriptionKeyStatus === "string" && session.subscriptionKeyStatus
          ? session.subscriptionKeyStatus
          : null,
      routingMode: session.routingMode === "per_user" || session.routingMode === "shared" ? session.routingMode : null,
    });
  }

  clear() {
    try { fs.unlinkSync(this.path); } catch {}
  }
}

/** Decode a JWT payload's `exp` (seconds). No signature check — the
 *  server is the authority; this only drives the refresh schedule. */
export function jwtExpSec(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function deviceNameDefault() {
  try {
    const h = os.hostname();
    return h && h.trim() ? h.trim() : "Ronin Desktop";
  } catch {
    return "Ronin Desktop";
  }
}

export class AuthManager {
  constructor({ store, fetchFn, serverUrl, panelUrl, deviceName } = {}) {
    this.store = store || new CredentialStore();
    this.fetchFn = fetchFn || ((...args) => fetch(...args));
    this._serverUrlOpt = serverUrl;
    this._panelUrlOpt = panelUrl;
    this.deviceName = deviceName || deviceNameDefault();
    this._subscription = null; // last known account-status cache
    this._hasChecked = false; // a revalidate() succeeded at least once since boot
    this._refreshPromise = null;
    this._revalidatePromise = null;
    this._credentialPromise = null;
    this._credentialFetchNeeded = false;
  }

  serverUrl() {
    const raw =
      (typeof this._serverUrlOpt === "function" ? this._serverUrlOpt() : this._serverUrlOpt) ||
      process.env.RONIN_SERVER_URL ||
      config.roninServerUrl ||
      DEFAULT_SERVER_URL;
    return String(raw).replace(/\/+$/, "");
  }

  panelUrl() {
    const raw =
      (typeof this._panelUrlOpt === "function" ? this._panelUrlOpt() : this._panelUrlOpt) ||
      process.env.RONIN_PANEL_URL ||
      config.panelUrl ||
      DEFAULT_PANEL_URL;
    return String(raw).replace(/\/+$/, "");
  }

  state() {
    const session = this.store.load();
    let subscription = null;
    if (this._subscription) {
      subscription = { ...this._subscription };
      // GUI-visible minimum only (design §5.3): a masked form + the
      // key status. The raw delegated key NEVER leaves the store.
      const key = session?.subscriptionKey || null;
      subscription.subscriptionKeyMasked = key ? maskedKey(key) : null;
      subscription.subscriptionKeyStatus =
        session?.subscriptionKeyStatus || subscription.providerKey?.status || null;
    }
    return {
      loggedIn: Boolean(session),
      user: session ? session.user : null,
      subscription,
    };
  }

  /** 'per_user' | 'shared' — learned from the server (account-status
   *  payload / credential endpoint), never a client-side flag (§11). */
  subscriptionRoutingMode() {
    if (this._subscription?.routingMode) return this._subscription.routingMode;
    const stored = this.store.load();
    return stored?.routingMode || "shared";
  }

  /** The stored delegated key (host-internal only — callers must never
   *  log it or forward it to the GUI). Null in shared mode.
   *  Corruption guard: a stored fingerprint that does not match the
   *  stored key means the record was tampered with or half-written —
   *  the key is dropped (never used, never "repaired" by falling back
   *  to the session token) and the next ensure/fetch re-fetches it. */
  getSubscriptionKey() {
    const s = this.store.load();
    if (!s?.subscriptionKey) return null;
    if (
      s.subscriptionKeyFingerprint &&
      s.subscriptionKeyFingerprint !== subscriptionKeyFingerprint(s.subscriptionKey)
    ) {
      log.warn("subscription_key_corrupt_cleared", {});
      this._clearSubscriptionKey();
      return null;
    }
    return s.subscriptionKey;
  }

  getSubscriptionKeyFingerprint() {
    const s = this.store.load();
    if (!s?.subscriptionKey) return null;
    return s.subscriptionKeyFingerprint || subscriptionKeyFingerprint(s.subscriptionKey);
  }

  // ---------- session lifecycle ----------

  _persistSession(body) {
    const prev = this.store.load();
    const nextUser = body.user ?? prev?.user ?? null;
    // Account switch must never carry the previous account's delegated
    // key over: preserve the key only when the user is unchanged.
    const sameUser = !prev?.user?.id || !nextUser?.id || prev.user.id === nextUser.id;
    const session = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      deviceId: body.deviceId ?? prev?.deviceId ?? null,
      user: nextUser,
      serverUrl: this.serverUrl(),
      subscriptionKey: sameUser ? (prev?.subscriptionKey ?? null) : null,
      subscriptionKeyFingerprint: sameUser ? (prev?.subscriptionKeyFingerprint ?? null) : null,
      subscriptionKeyStatus: sameUser ? (prev?.subscriptionKeyStatus ?? null) : null,
      routingMode: sameUser ? (prev?.routingMode ?? null) : null,
    };
    this.store.save(session);
    return session;
  }

  _clearSession() {
    this.store.clear();
    this._subscription = null;
    this._hasChecked = false;
    this._credentialFetchNeeded = false;
  }

  /** Drop only the delegated key, keeping the session itself. Used on
   *  account-disabled revalidation, routing rollback to shared mode,
   *  and when the credential endpoint reports none/deleted/frozen. */
  _clearSubscriptionKey() {
    const s = this.store.load();
    if (!s) return;
    if (!s.subscriptionKey && !s.subscriptionKeyFingerprint && !s.subscriptionKeyStatus) return;
    this.store.save({
      ...s,
      subscriptionKey: null,
      subscriptionKeyFingerprint: null,
      subscriptionKeyStatus: null,
    });
  }

  _saveSubscriptionKey(key, keyStatus, routingMode) {
    const s = this.store.load();
    if (!s || typeof key !== "string" || !key) return null;
    const fp = subscriptionKeyFingerprint(key);
    this.store.save({
      ...s,
      subscriptionKey: key,
      subscriptionKeyFingerprint: fp,
      subscriptionKeyStatus: keyStatus || "active",
      routingMode: routingMode || s.routingMode || "per_user",
    });
    return fp;
  }

  _persistRoutingMode(mode) {
    const s = this.store.load();
    if (!s || s.routingMode === mode) return;
    this.store.save({ ...s, routingMode: mode });
  }

  async _post(pathname, body, { bearer } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await this.fetchFn(`${this.serverUrl()}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const code =
        data && typeof data.error === "string"
          ? data.error
          : data && data.error && typeof data.error.code === "string"
            ? data.error.code
            : `http_${res.status}`;
      throw new AuthError(res.status, code);
    }
    return data ?? {};
  }

  _errorCode(data, status) {
    if (data && typeof data.error === "string") return data.error;
    if (data && data.error && typeof data.error.code === "string") return data.error.code;
    if (data && typeof data.code === "string") return data.code;
    return `http_${status}`;
  }

  async _get(pathname, token) {
    const res = await this.fetchFn(`${this.serverUrl()}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new AuthError(res.status, this._errorCode(data, res.status));
    return data ?? {};
  }

  // ---------- delegated subscription credential (design §5) ----------

  /**
   * Fetch the user's own delegated provider key from
   * GET /api/subscription/credential over the authenticated session
   * channel (the server's device-registry check applies there).
   *
   * Returns a SANITISED summary — never the key itself — so no caller
   * can accidentally log or forward the plaintext. The key is written
   * straight into the CredentialStore. Definitive server rejections
   * throw AuthError; network failures return null (best-effort, the
   * next revalidate / turn retries). Never logs key material.
   */
  async fetchSubscriptionCredential() {
    if (this._credentialPromise) return this._credentialPromise;
    const p = (async () => {
      if (!this.store.load()) return null;
      const token = await this.ensureFreshAccess();
      if (!token) return null;
      let data;
      try {
        data = await this._get("/api/subscription/credential", token);
      } catch (e) {
        if (e instanceof AuthError) {
          if (e.status === 404) {
            // Older server without the endpoint: stay in shared mode.
            return { routingMode: "shared", keyStatus: null };
          }
          if (e.code === "account_disabled" || e.code === "account_suspended") {
            this._clearSubscriptionKey();
          }
          throw e;
        }
        log.warn("subscription_credential_fetch_failed", { error: "network" });
        return null;
      }
      const routingMode = data.routingMode === "per_user" ? "per_user" : "shared";
      if (routingMode === "shared") {
        this._clearSubscriptionKey();
        this._persistRoutingMode("shared");
        if (this._subscription) {
          this._subscription = { ...this._subscription, routingMode: "shared" };
        }
        log.info("subscription_credential_fetched", { routingMode, keyStatus: null });
        return { routingMode, keyStatus: null, tokenLimitIssued: null };
      }
      const keyStatus = typeof data.keyStatus === "string" ? data.keyStatus : "none";
      const tokenLimitIssued = typeof data.tokenLimitIssued === "number" ? data.tokenLimitIssued : null;
      this._persistRoutingMode("per_user");
      if (this._subscription) {
        this._subscription = {
          ...this._subscription,
          routingMode: "per_user",
          providerKey: {
            status: keyStatus,
            tokenLimitIssued,
            balanceStale: this._subscription.providerKey?.balanceStale ?? false,
          },
        };
      }
      if (keyStatus === "none" || keyStatus === "deleted" || keyStatus === "frozen") {
        // No spendable key to hold: frozen keys are withheld by the
        // server (§5.2) and a stale local copy must not be used.
        this._clearSubscriptionKey();
      } else if (typeof data.delegatedKey === "string" && data.delegatedKey) {
        if (keyStatus === "active" || keyStatus === "needs_attention") {
          // Compare-by-hash happens inside the store write: a rotated /
          // replacement key simply overwrites the old fingerprint.
          this._saveSubscriptionKey(data.delegatedKey, keyStatus, "per_user");
        }
      }
      // pending_create without key material: keep any existing key —
      // provisioning is transient and must not wipe a working key.
      log.info("subscription_credential_fetched", { routingMode, keyStatus });
      return { routingMode, keyStatus, tokenLimitIssued, hasKey: Boolean(this.getSubscriptionKey()) };
    })();
    this._credentialPromise = p;
    try {
      return await p;
    } finally {
      if (this._credentialPromise === p) this._credentialPromise = null;
    }
  }

  /** Force a credential re-fetch (key-shaped turn failures, §5.2c). */
  async refreshSubscriptionCredential() {
    return this.fetchSubscriptionCredential();
  }

  /**
   * The delegated key for a subscription turn, fetching it exactly
   * once first when absent (design §12.3). Null in shared mode or when
   * the server has no active key yet (pending_create / none).
   */
  async ensureSubscriptionKey() {
    if (this.subscriptionRoutingMode() !== "per_user") return null;
    const existing = this.getSubscriptionKey();
    if (existing) return existing;
    try {
      await this.fetchSubscriptionCredential();
    } catch {
      return null;
    }
    return this.getSubscriptionKey();
  }

  async exchangeCode(code) {
    const body = await this._post("/api/auth/handoff/exchange", {
      code,
      deviceName: this.deviceName,
    });
    const session = this._persistSession(body);
    await this.revalidate();
    return { user: session.user };
  }

  async requestOtp(phone) {
    return this._post("/api/auth/otp/request", { phone });
  }

  async verifyOtp(phone, code) {
    const body = await this._post("/api/auth/otp/verify", {
      phone,
      code,
      deviceName: this.deviceName,
    });
    const session = this._persistSession(body);
    await this.revalidate();
    return { user: session.user };
  }

  async logout() {
    const session = this.store.load();
    if (session) {
      try {
        await this._post("/api/auth/logout", {}, { bearer: session.accessToken });
      } catch {
        // Best-effort: local logout always wins.
      }
    }
    this._clearSession();
  }

  // ---------- token freshness ----------

  async _refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    const p = (async () => {
      const session = this.store.load();
      if (!session) return null;
      let body;
      try {
        body = await this._post("/api/auth/refresh", { refreshToken: session.refreshToken });
      } catch (e) {
        if (e instanceof AuthError) {
          if (e.status === 401) {
            log.warn("auth_session_cleared", { code: e.code });
            this._clearSession();
            return null;
          }
          // Non-401 server error: keep the session, hand back the
          // current token and let account-status arbitrate.
          return session.accessToken;
        }
        // Network failure: same grace as above.
        return session.accessToken;
      }
      const next = this._persistSession(body);
      return next.accessToken;
    })();
    this._refreshPromise = p;
    try {
      return await p;
    } finally {
      if (this._refreshPromise === p) this._refreshPromise = null;
    }
  }

  /** A usable access token, refreshing first when <60s remain. */
  async ensureFreshAccess({ force = false } = {}) {
    const session = this.store.load();
    if (!session) return null;
    if (!force) {
      const exp = jwtExpSec(session.accessToken);
      if (exp === null || exp - Math.floor(Date.now() / 1000) >= 60) {
        return session.accessToken;
      }
    }
    return this._refresh();
  }

  // ---------- account status / subscription gate ----------

  async _fetchAccountStatus(token) {
    const res = await this.fetchFn(`${this.serverUrl()}/api/account-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new AuthError(res.status, this._errorCode(data, res.status));
    }
    return data ?? {};
  }

  _cacheSubscription(body) {
    const prev = this._subscription;
    // §7.1 / §11: routingMode + providerKey arrive on account-status in
    // per-user mode; older/shared servers omit them → shared. Balance
    // fields keep their names, so the GUI header keeps working — in
    // per-user mode the server fills them from the provider (§7.1).
    const routingMode = body.routingMode === "per_user" ? "per_user" : "shared";
    const pk = body.providerKey && typeof body.providerKey === "object" ? body.providerKey : null;
    const providerKey = pk
      ? {
          status: typeof pk.status === "string" ? pk.status : null,
          tokenLimitIssued: typeof pk.tokenLimitIssued === "number" ? pk.tokenLimitIssued : null,
          balanceStale: pk.balanceStale === true,
        }
      : prev?.providerKey && routingMode === "per_user"
        ? prev.providerKey
        : { status: null, tokenLimitIssued: null, balanceStale: false };
    this._subscription = {
      status: typeof body.status === "string" ? body.status : "disabled",
      isActive: body.isActive === true,
      balanceTokens: typeof body.balanceTokens === "number" ? body.balanceTokens : 0,
      spendableTokens: typeof body.spendableTokens === "number" ? body.spendableTokens : 0,
      deviceAuthorized: body.deviceAuthorized === true,
      activeDevices: typeof body.activeDevices === "number" ? body.activeDevices : null,
      serverTime: typeof body.serverTime === "string" ? body.serverTime : null,
      lots: Array.isArray(body.lots) ? body.lots : [],
      routingMode,
      providerKey,
      checkedAt: new Date().toISOString(),
      stale: false,
    };
    this._hasChecked = true;
    // §5.3 clear triggers evaluated against the fresh server state.
    if (this._subscription.status !== "active" || this._subscription.isActive !== true) {
      this._clearSubscriptionKey();
    } else if (routingMode === "shared" && prev?.routingMode === "per_user") {
      this._clearSubscriptionKey();
    }
    this._persistRoutingMode(routingMode);
    // §5.2(b): (re)fetch the credential when per-user routing is new,
    // the stored key is missing, or the key status / issued limit
    // changed since the previous check.
    this._credentialFetchNeeded =
      routingMode === "per_user" &&
      this._subscription.status === "active" &&
      (!this.getSubscriptionKey() ||
        prev?.routingMode !== "per_user" ||
        prev?.providerKey?.status !== providerKey.status ||
        prev?.providerKey?.tokenLimitIssued !== providerKey.tokenLimitIssued);
    return this._subscription;
  }

  /** Cache + the credential fetch a fresh cache may require (§5.2). */
  async _cacheAndFetchCredential(body) {
    const sub = this._cacheSubscription(body);
    if (this._credentialFetchNeeded) {
      this._credentialFetchNeeded = false;
      try {
        await this.fetchSubscriptionCredential();
      } catch (e) {
        // Best-effort: a refused credential (e.g. suspended) must not
        // break revalidation — the subscription cache already carries
        // the locked state the GUI/turn gate act on.
        log.warn("subscription_credential_fetch_failed", { code: e instanceof AuthError ? e.code : "unknown" });
      }
    }
    return sub;
  }

  /**
   * Refresh the cached subscription state from the server.
   * Network failure keeps the last cache (flagged stale) instead of
   * locking the user out; a definitive 401 (after one refresh+retry)
   * clears the session. Never throws.
   */
  async revalidate() {
    if (this._revalidatePromise) return this._revalidatePromise;
    const p = (async () => {
      if (!this.store.load()) {
        this._subscription = null;
        return null;
      }
      const token = await this.ensureFreshAccess();
      if (!token) {
        // Refresh said the session is dead and cleared the store.
        this._subscription = null;
        return null;
      }
      try {
        const body = await this._fetchAccountStatus(token);
        return this._cacheAndFetchCredential(body);
      } catch (e) {
        if (e instanceof AuthError && e.status === 401) {
          // One forced refresh + retry before giving up the session.
          const fresh = await this.ensureFreshAccess({ force: true });
          if (!fresh) {
            this._subscription = null;
            return null;
          }
          try {
            const body = await this._fetchAccountStatus(fresh);
            return this._cacheAndFetchCredential(body);
          } catch (e2) {
            if (e2 instanceof AuthError && e2.status === 401) {
              log.warn("auth_session_cleared", { code: e2.code });
              this._clearSession();
              return null;
            }
            return this._markStale();
          }
        }
        return this._markStale();
      }
    })();
    this._revalidatePromise = p;
    try {
      return await p;
    } finally {
      if (this._revalidatePromise === p) this._revalidatePromise = null;
    }
  }

  _markStale() {
    if (this._subscription) this._subscription = { ...this._subscription, stale: true };
    return this._subscription;
  }

  /**
   * Whether subscription features are locked right now.
   * Matrix: not logged in → locked; cached status not active or this
   * device not authorized → locked. Grace choice (deliberate): when no
   * check has ever succeeded since boot but a stored session exists,
   * the last-known state is "unknown", not "bad" — report UNLOCKED and
   * let the turn flow attempt a revalidate() first; a network failure
   * there still allows the turn (flagged stale), while a definitive
   * disabled/unauthorized answer locks. This keeps a server outage
   * from bricking paying users on launch day.
   */
  subscriptionLocked() {
    if (!this.store.load()) return true;
    if (!this._subscription) return false; // never checked → grace (see above)
    return this._subscription.deviceAuthorized !== true || this._subscription.status !== "active";
  }
}

export const authManager = new AuthManager();

/**
 * Boot wiring (called by the HTTP server; importing this module alone
 * starts nothing, so unit tests stay hermetic): revalidate a stored
 * session in the background and re-check every 6 hours.
 */
export function initAuthBackground(manager = authManager) {
  if (manager.store.load()) {
    manager.revalidate().catch(() => {});
  }
  const timer = setInterval(() => {
    manager.revalidate().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
