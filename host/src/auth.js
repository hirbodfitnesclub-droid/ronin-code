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
import { CREDENTIALS_PATH } from "./paths.js";
import { readJsonFile, writeJsonFile0600 } from "./util.js";
import { config } from "./config.js";
import { log } from "./log.js";

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
    return {
      loggedIn: Boolean(session),
      user: session ? session.user : null,
      subscription: this._subscription ? { ...this._subscription } : null,
    };
  }

  // ---------- session lifecycle ----------

  _persistSession(body) {
    const prev = this.store.load();
    const session = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      deviceId: body.deviceId ?? prev?.deviceId ?? null,
      user: body.user ?? prev?.user ?? null,
      serverUrl: this.serverUrl(),
    };
    this.store.save(session);
    return session;
  }

  _clearSession() {
    this.store.clear();
    this._subscription = null;
    this._hasChecked = false;
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
      const code =
        data && typeof data.error === "string" ? data.error : `http_${res.status}`;
      throw new AuthError(res.status, code);
    }
    return data ?? {};
  }

  _cacheSubscription(body) {
    this._subscription = {
      status: typeof body.status === "string" ? body.status : "disabled",
      isActive: body.isActive === true,
      balanceTokens: typeof body.balanceTokens === "number" ? body.balanceTokens : 0,
      spendableTokens: typeof body.spendableTokens === "number" ? body.spendableTokens : 0,
      deviceAuthorized: body.deviceAuthorized === true,
      activeDevices: typeof body.activeDevices === "number" ? body.activeDevices : null,
      serverTime: typeof body.serverTime === "string" ? body.serverTime : null,
      lots: Array.isArray(body.lots) ? body.lots : [],
      checkedAt: new Date().toISOString(),
      stale: false,
    };
    this._hasChecked = true;
    return this._subscription;
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
        return this._cacheSubscription(body);
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
            return this._cacheSubscription(body);
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
