import { ApiError } from './errors';
import { clearSession, loadSession, saveSession } from './session';
import { deriveUsage, isPerUserMode, mapRecentUsage } from './usage';
import type {
  AccountStatus,
  Claim,
  CreditsResult,
  Device,
  HandoffResult,
  MeResult,
  OnboardingInput,
  OrderRow,
  OtpVerifyResult,
  PacksResult,
  PanelApi,
  RecentUsageResult,
  RoutingMode,
  Session,
  UsageSummary,
  User,
} from './types';

const BASE: string = import.meta.env.VITE_API_BASE_URL ?? '';

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class LiveApiClient implements PanelApi {
  private session: Session | null = loadSession();
  /** Routing mode (§7.1) is learned from /api/account-status and cached for
      60s so usageSummary()/recentUsage() can branch without a fetch storm.
      Dashboard calls accountStatus() + usageSummary() in parallel; the
      in-flight promise is shared. */
  private routingCache: { mode: RoutingMode; at: number } | null = null;
  private routingInFlight: Promise<RoutingMode> | null = null;

  getSession(): Session | null {
    return this.session;
  }

  private setSession(s: Session | null): void {
    this.session = s;
    if (s) saveSession(s);
    else clearSession();
  }

  private async raw(path: string, init: RequestInit, retry = true): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(this.session ? { Authorization: `Bearer ${this.session.accessToken}` } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new ApiError(0, 'network', 'Network error');
    }
    if (res.status === 401 && retry && this.session) {
      const refreshed = await this.tryRefresh();
      if (refreshed) return this.raw(path, init, false);
      this.setSession(null);
    }
    const body = (await res.json().catch(() => ({}))) as ErrorBody & Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(res.status, body.error?.code ?? 'unknown', body.error?.message ?? res.statusText);
    }
    return body;
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.session) return false;
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      this.setSession({ ...this.session, accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } catch {
      return false;
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.raw(path, { method: 'GET' }) as Promise<T>;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.raw(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as Promise<T>;
  }

  async requestOtp(phone: string): Promise<{ ok: boolean }> {
    return this.post('/api/auth/otp/request', { phone });
  }

  async verifyOtp(phone: string, code: string, deviceName: string): Promise<OtpVerifyResult> {
    const r = await this.post<OtpVerifyResult>('/api/auth/otp/verify', { phone, code, deviceName });
    this.setSession({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      deviceId: r.deviceId,
      user: r.user,
    });
    return r;
  }

  async logout(): Promise<void> {
    try {
      await this.post('/api/auth/logout');
    } finally {
      this.setSession(null);
    }
  }

  async logoutAll(): Promise<void> {
    try {
      await this.post('/api/auth/logout-all');
    } finally {
      this.setSession(null);
    }
  }

  me(): Promise<MeResult> {
    return this.get('/api/me');
  }

  async submitOnboarding(input: OnboardingInput): Promise<User> {
    const r = await this.post<{ user: User }>('/api/me/onboarding', input);
    if (this.session) this.setSession({ ...this.session, user: r.user });
    return r.user;
  }

  async accountStatus(): Promise<AccountStatus> {
    const status = await this.get<AccountStatus>('/api/account-status');
    if (status.routingMode) this.routingCache = { mode: status.routingMode, at: Date.now() };
    return status;
  }

  /** Resolve the routing mode, defaulting to 'shared' on any failure so the
      v1 ledger-derived path remains the safe fallback. */
  async routingMode(): Promise<RoutingMode> {
    if (this.routingCache && Date.now() - this.routingCache.at < 60_000) return this.routingCache.mode;
    if (!this.routingInFlight) {
      this.routingInFlight = this.accountStatus()
        .then((s) => s.routingMode ?? 'shared')
        .catch(() => 'shared' as RoutingMode)
        .finally(() => {
          this.routingInFlight = null;
        });
    }
    return this.routingInFlight;
  }

  packs(): Promise<PacksResult> {
    return this.get('/api/packs');
  }

  credits(): Promise<CreditsResult> {
    return this.get('/api/credits');
  }

  async devices(): Promise<Device[]> {
    const r = await this.get<{ devices: Device[] }>('/api/devices');
    return r.devices;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.raw(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /* CLAIMS ADAPTER — claims live on /api/orders, there is NO /api/claims route.
     Create: POST /api/orders as multipart/form-data (text field `packId` +
     file part `receipt`, image/* only, <= 5 MB). List: GET /api/orders.
     The factory routes claims here by default (VITE_CLAIMS_ADAPTER unset or
     'live'); 'mock' is only for offline UI work.
     Purchases must use listClaims() — never /api/credits' embedded orders. */
  async listClaims(): Promise<Claim[]> {
    const r = await this.get<{ orders: OrderRow[] }>('/api/orders');
    return r.orders.map(toClaim);
  }

  async createClaim(packId: string, receiptFile: File): Promise<Claim> {
    const form = new FormData();
    form.append('packId', packId);
    form.append('receipt', receiptFile);
    const r = (await this.raw('/api/orders', { method: 'POST', body: form })) as { order: OrderRow } & OrderRow;
    return toClaim(r.order ?? r);
  }

  /* §7.3 / C6: per-user mode MUST NOT derive from ledger consume rows (they
     stop being written and the dashboard would silently flatline). The server
     summary endpoint is computed from key_usage_daily rollups instead. */
  async usageSummary(): Promise<UsageSummary> {
    if (isPerUserMode(await this.routingMode())) {
      return this.get<UsageSummary>('/api/usage/summary');
    }
    return deriveUsage(await this.credits());
  }

  /* §7.2: recent activity from the provider-logs-backed endpoint. Shared-mode
     users have no delegated key — return null and the UI hides the section. */
  async recentUsage(): Promise<RecentUsageResult | null> {
    if (!isPerUserMode(await this.routingMode())) return null;
    return mapRecentUsage(await this.get('/api/usage/recent'));
  }

  /** Mint a one-time desktop connection code (Bearer session required). */
  async issueHandoff(): Promise<HandoffResult> {
    return this.post<HandoffResult>('/api/auth/handoff');
  }
}

export function toClaim(o: OrderRow): Claim {
  return {
    id: o.id,
    packId: o.packId,
    packTitle: o.packTitle,
    tokens: o.tokens,
    priceRials: o.priceRials,
    status: o.status,
    rejectReason: o.rejectReason,
    adminNote: o.adminNote,
    hasReceipt: o.hasReceipt,
    createdAt: o.createdAt,
    reviewedAt: o.reviewedAt,
    issuanceState: o.issuanceState ?? null,
  };
}
