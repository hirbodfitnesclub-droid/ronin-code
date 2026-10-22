// Admin API client — same origin, cookie session, CSRF header on mutations.
// Contract: errors are { error: { code, message } }.

export interface Session {
  phone: string;
  csrfToken: string;
  role: 'owner' | 'staff';
  caps: string[];
}

export interface Order {
  id: string;
  userId: string;
  userPhone: string;
  packId: string;
  packTitle: string;
  tokens: number;
  priceRials: number;
  receivedAmountRials: number | null;
  payerName: string | null;
  cardLast4: string | null;
  reference: string | null;
  paidAtText: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'refunded';
  rejectReason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  createdAt: number;
  hasReceipt: boolean;
  duplicateReceipt: boolean;
}

export interface Refund {
  id: string;
  orderId: string;
  amountRials: number;
  tokensRemoved: number;
  reason: string;
  reference: string | null;
  actor: string;
  createdAt: number;
}

export interface AdminUser {
  id: string;
  phone: string;
  name: string | null;
  isActive: boolean;
  balanceTokens?: number;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  deltaTokens: number;
  amountTokens: number;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdAt: number;
}

export interface Lot {
  id: string;
  source: string;
  tokensTotal: number;
  tokensLeft: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  active: boolean;
}

export interface RiskFlag {
  id: string;
  userId: string;
  kind: string;
  note: string | null;
  status: string;
  createdBy: string;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface Overview {
  users: number;
  revenueRials: number;
  pendingOrders: number;
  tokensConsumed: number;
  tokensGranted: number;
  refundedRials: number;
}

export interface Expense {
  id: string;
  amountRials: number;
  category: string;
  note: string | null;
  spentOn: string;
  actor: string;
  createdAt: number;
  updatedAt: number;
}

export interface Period {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
  closedAt: number | null;
  closedBy: string | null;
  createdBy: string;
  createdAt: number;
}

export interface Pnl {
  from: string;
  to: string;
  incomeRials: number;
  refundRials: number;
  expenseRials: number;
  netRials: number;
  expensesByCategory: { category: string; totalRials: number }[];
  daily: { date: string; incomeRials: number; expenseRials: number }[];
}

export interface AnalyticsOverview {
  days: number;
  series: { date: string; newUsers: number; totalUsers: number; revenueRials: number; consumedTokens: number }[];
  topModels: { model: string; tokens: number; requests: number }[];
  // Backend sends approvalRate already as a percent (0–100) or null.
  claims: { pending: number; approved: number; rejected: number; refunded: number; approvalRate: number | null };
  totals: { users: number; revenueRials: number; consumedTokens: number; grantedTokens: number };
}

export interface Pack {
  id: string;
  title: string;
  usd?: number;
  tokens?: number;
  priceRials: number;
  validityDays: number;
  badge: string | null;
  note: string | null;
}

export interface ModelConfig {
  model: string;
  multiplier: number;
  enabled: boolean;
}

export interface Settings {
  card: { number: string; holder: string; bank: string };
  packs: Pack[];
  models: ModelConfig[];
  tokenConfig: { tokensPerUsd: number; defaultMultiplier: number; usdRialRate: number };
  financeStaff: { phone: string; caps: string[] }[] | null;
  smsProvider: string;
  smsTemplatesConfigured: boolean;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: number;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrfToken = '';
export function setCsrf(token: string): void {
  csrfToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path, { ...init, method, headers, credentials: 'include' });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `خطای ${res.status}`);
  }
  return data as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  requestOtp: (phone: string) => post<{ ok: boolean }>('/admin-api/auth/otp/request', { phone }),
  verifyOtp: (phone: string, code: string) =>
    post<Session>('/admin-api/auth/otp/verify', { phone, code }),
  session: () => get<Session>('/admin-api/session'),
  logout: () => post<{ ok: boolean }>('/admin-api/auth/logout'),

  overview: () => get<Overview>('/admin-api/overview'),
  orders: (status?: string) =>
    get<{ orders: Order[] }>(`/admin-api/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  order: (id: string) =>
    get<{ order: Order; user: { id: string; phone: string; name: string | null }; refunds: Refund[] }>(
      `/admin-api/orders/${encodeURIComponent(id)}`,
    ),
  reviewOrder: (id: string, body: { action: 'approve' | 'reject'; receivedAmountRials?: number; reason?: string; note?: string }) =>
    post<{ order: Order; grantedTokens: number }>(`/admin-api/orders/${encodeURIComponent(id)}/review`, body),
  refundOrder: (id: string, body: { amountRials: number; reason: string; reference?: string; idempotencyKey: string }) =>
    post<{ refund: Refund; tokensRemoved: number; replayed: boolean; order: Order }>(
      `/admin-api/orders/${encodeURIComponent(id)}/refund`,
      body,
    ),

  users: (search = '') =>
    get<{ users: AdminUser[] }>(`/admin-api/users${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  user: (id: string) =>
    get<{
      user: { id: string; phone: string; name: string | null; isActive: boolean; createdAt: number; lastLoginAt: number | null; onboarded: boolean; acquisitionSource: string | null; onboardingGoal: string | null };
      balanceTokens: number;
      ledger: LedgerEntry[];
      orders: Order[];
      lots: Lot[];
      openRiskFlags: number;
    }>(`/admin-api/users/${encodeURIComponent(id)}`),
  chargeUser: (id: string, tokens: number, note: string) =>
    post<{ ok: boolean; balanceTokens: number }>(`/admin-api/users/${encodeURIComponent(id)}/charge`, { tokens, note }),
  toggleUserActive: (id: string, isActive: boolean) =>
    post<{ ok: boolean; isActive: boolean }>(`/admin-api/users/${encodeURIComponent(id)}/toggle-active`, { isActive }),
  userDevices: (id: string) => get<{ devices: Device[] }>(`/admin-api/users/${encodeURIComponent(id)}/devices`),
  revokeDevice: (id: string, deviceId: string) =>
    post<{ ok: boolean; devices: Device[] }>(
      `/admin-api/users/${encodeURIComponent(id)}/devices/${encodeURIComponent(deviceId)}/revoke`,
    ),
  userRiskFlags: (id: string) => get<{ flags: RiskFlag[] }>(`/admin-api/users/${encodeURIComponent(id)}/risk-flags`),
  createRiskFlag: (id: string, kind: string, note: string) =>
    post<{ flag: RiskFlag }>(`/admin-api/users/${encodeURIComponent(id)}/risk-flags`, { kind, note }),
  resolveRiskFlag: (flagId: string) => post<{ flag: RiskFlag }>(`/admin-api/risk-flags/${encodeURIComponent(flagId)}/resolve`),

  pnl: (params: string) => get<{ pnl: Pnl; period: Period | null }>(`/admin-api/finance/pnl?${params}`),
  expenses: (from: string, to: string) =>
    get<{ expenses: Expense[] }>(`/admin-api/finance/expenses?from=${from}&to=${to}`),
  createExpense: (body: { amountRials: number; category: string; note?: string; spentOn: string }) =>
    post<{ expense: Expense }>('/admin-api/finance/expenses', body),
  updateExpense: (id: string, body: { amountRials: number; category: string; note?: string; spentOn: string }) =>
    put<{ expense: Expense }>(`/admin-api/finance/expenses/${encodeURIComponent(id)}`, body),
  deleteExpense: (id: string) => del<{ ok: boolean }>(`/admin-api/finance/expenses/${encodeURIComponent(id)}`),
  periods: () => get<{ periods: Period[] }>('/admin-api/finance/periods'),
  createPeriod: (body: { title: string; startsOn: string; endsOn: string }) =>
    post<{ period: Period }>('/admin-api/finance/periods', body),
  closePeriod: (id: string) => post<{ period: Period }>(`/admin-api/finance/periods/${encodeURIComponent(id)}/close`),

  analytics: (days = 30) => get<AnalyticsOverview>(`/admin-api/analytics/overview?days=${days}`),
  analystChat: (messages: { role: string; content: string }[]) =>
    post<{ reply: string; model: string }>('/admin-api/analyst/chat', { messages }),

  settings: () => get<Settings>('/admin-api/settings'),
  saveCard: (card: { number: string; holder: string; bank: string }) =>
    put<{ ok: boolean }>('/admin-api/settings/card', card),
  savePacks: (packs: Pack[]) => put<{ ok: boolean }>('/admin-api/settings/packs', { packs }),
  saveModels: (models: ModelConfig[]) => put<{ ok: boolean }>('/admin-api/settings/models', { models }),
  saveTokenConfig: (tokenConfig: Settings['tokenConfig']) =>
    put<{ ok: boolean }>('/admin-api/settings/token-config', tokenConfig),
  saveFinanceStaff: (staff: { phone: string; caps: string[] }[]) =>
    put<{ ok: boolean }>('/admin-api/settings/finance-staff', { staff }),

  audit: (actor: string, action: string, limit: number, offset: number) => {
    const q = new URLSearchParams();
    if (actor) q.set('actor', actor);
    if (action) q.set('action', action);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return get<{ total: number; audit: AuditEntry[] }>(`/admin-api/audit?${q.toString()}`);
  },
};

export function hasCap(session: Session | null, cap: string): boolean {
  if (!session) return false;
  if (session.role === 'owner') return true;
  return session.caps.includes(cap);
}
