/* ------------------------------------------------------------------ */
/*  Ronin Code — API layer (contract v1). Typed request/response
   contracts for the whole host API live in this one module (lib/api).                               */
/*                                                                     */
/*  Token resolution (first hit wins):                                 */
/*    1. window.__RONIN_TOKEN__  — injected by the host via            */
/*       <script src="/ronin-config.js"> in index.html                 */
/*    2. ?token= in the page URL — handy in Vite dev                   */
/*    3. "" — the UI still renders; calls simply go unauthenticated    */
/*                                                                     */
/*  Every /api/* request sends  X-Ronin-Token: <token>.                */
/*  The SSE stream cannot set headers, so its token rides in the      */
/*  query string:  GET /api/stream?token=<token>                      */
/* ------------------------------------------------------------------ */

export function getToken(): string {
  if (typeof window !== 'undefined') {
    if (window.__RONIN_TOKEN__) return window.__RONIN_TOKEN__;
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('token');
      if (fromUrl) return fromUrl;
    } catch {
      /* malformed URL — fall through to empty token */
    }
  }
  return '';
}

export type Mode = 'live' | 'preview';

export interface ProviderKey {
  index: number;
  maskedKey: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  coolingDown: boolean;
}

export interface Provider {
  id: string;
  label: string;
  defaultModel: string;
  hasKey: boolean;
  maskedKey: string;
  keys: ProviderKey[];
  baseUrl?: string;
}

export type ProjectMode = 'auto' | 'plan' | null;

export interface Status {
  mode: Mode;
  provider: string;
  model: string;
  hasKey: boolean;
  project: string;
  onboarded: boolean;
  language: 'en' | 'fa';
  autoMode: boolean;
  planMode: boolean;
  projectMode: ProjectMode;
  envAccess: boolean;
  budgetCapUsd: number | null;
  failover: boolean;
}

export interface PlanStep {
  title: string;
  detail: string;
  state?: 'pending' | 'active' | 'done';
}

export interface Checkpoint {
  id: string;
  name: string;
  ts: string;
  files: number;
}

export interface DiffFile {
  path: string;
  action: string;
  diff: string | null;
}

export interface UsageView {
  totals: { turns: number; inputTokens: number; outputTokens: number; costUsd: number };
  recent: Array<{
    ts: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    estimated: boolean;
  }>;
  rtk: { calls: number; savedChars: number };
  budgetCapUsd: number | null;
}

export interface Starter {
  id: string;
  name: { en: string; fa: string };
  tagline: { en: string; fa: string };
  accent: string;
}

export interface MaturedIdea {
  audience: { who: string; pain: string };
  features: string[];
  plan: Array<{ title: string; detail: string }>;
  simulated: boolean;
}

export interface ChangedFile {
  path: string;
  action: string; // "created" | "modified" | … (host-defined)
}

export type ActivityKind =
  'planning' | 'thinking' | 'reading' | 'writing' | 'editing' | 'terminal' | 'searching' | 'reviewing';

export interface ApprovalDetail {
  tool: string;
  command?: string;
  path?: string;
  project?: string;
}

export type StreamEvent =
  | { type: 'activity_start'; activityId: string; kind: ActivityKind }
  | { type: 'activity_end'; activityId: string; kind?: ActivityKind }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'changes'; files: ChangedFile[] }
  | { type: 'turn_done' }
  | { type: 'turn_error'; message: string }
  | { type: 'approval_request'; approvalId: string; kind: 'command' | 'write_outside'; detail: ApprovalDetail }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'plan_proposed'; planId: string; task: string; steps: PlanStep[] }
  | { type: 'plan_progress'; planId: string; steps: PlanStep[] }
  | { type: 'plan_cleared'; planId: string }
  | {
      type: 'turn_usage';
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      estimated: boolean;
      sessionTotalUsd: number;
    }
  | { type: 'provider_switched'; provider: string; model: string }
  | { type: 'budget_warning'; capUsd: number; totalUsd: number }
  | { type: 'budget_exceeded'; capUsd: number; totalUsd: number };

/** Error carrying the host's stable error code (for i18n) when present. */
export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Ronin-Token': getToken(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    let code: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; error?: string; code?: string };
      detail = body.message || body.error || '';
      code = body.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail || `Request failed (${res.status})`, code);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export interface SettingsBody {
  provider?: string;
  apiKey?: string;
  apiKeys?: string[];
  addKeys?: string[];
  removeKeyIndex?: number;
  keysProvider?: string;
  model?: string;
  baseUrl?: string;
  onboarded?: boolean;
  language?: 'en' | 'fa';
  autoMode?: boolean;
  planMode?: boolean;
  projectMode?: 'auto' | 'plan' | null;
  failover?: boolean;
  failoverOrder?: string[];
  budgetCapUsd?: number | null;
  envAccess?: boolean;
}

export const api = {
  health: () => get<{ ok: boolean }>('/health'),

  providers: () => get<Provider[]>('/api/providers'),

  status: () => get<Status>('/api/status'),

  saveSettings: (body: SettingsBody) => post<unknown>('/api/settings', body),

  testSettings: (provider: string, baseUrl?: string) =>
    post<{ ok: boolean; message: string }>('/api/settings/test', { provider, ...(baseUrl ? { baseUrl } : {}) }),

  selectProject: (path: string) => post<{ path: string }>('/api/projects/select', { path }),

  starters: () => get<Starter[]>('/api/starters'),

  starterProject: (starterId?: string) =>
    post<{ path: string }>('/api/projects/starter', starterId ? { starterId } : {}),

  startTurn: (prompt: string) => post<{ ok: boolean; turnId: string }>('/api/turn', { prompt }),

  undo: () => post<{ ok: boolean; files: ChangedFile[] }>('/api/undo'),
  logClientError: (payload: { message: string; stack?: string }) => post<{ ok: boolean }>('/api/client-error', payload),

  approval: (id: string, approved: boolean) =>
    post<{ ok: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, { approved }),

  planApprove: (planId: string) => post<{ ok: boolean }>('/api/plan/approve', { planId }),

  planReject: (planId: string) => post<{ ok: boolean }>('/api/plan/reject', { planId }),

  checkpoints: () => get<Checkpoint[]>('/api/checkpoints'),

  createCheckpoint: (name: string) => post<Checkpoint>('/api/checkpoints', { name }),

  restoreCheckpoint: (id: string) => post<{ ok: boolean; name: string }>('/api/checkpoints/restore', { id }),

  diff: () => get<{ files: DiffFile[] }>('/api/diff'),

  usage: () => get<UsageView>('/api/usage'),

  matureIdea: (idea: string) => post<MaturedIdea>('/api/ideas/mature', { idea }),

  buildIdea: (idea: string, mature: MaturedIdea) =>
    post<{ ok: boolean; path: string }>('/api/ideas/build', { idea, mature }),

  exportDist: () => post<{ ok: boolean; path: string; files: number }>('/api/projects/export-dist'),

  /** Download the project zip (token header rides along via fetch). */
  exportZip: async (): Promise<Blob> => {
    const res = await fetch('/api/projects/export', {
      headers: { 'X-Ronin-Token': getToken() },
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.blob();
  },

  /** EventSource URL — token in query because headers aren't possible. */
  streamUrl: () => `/api/stream?token=${encodeURIComponent(getToken())}`,
};

/** Open the SSE stream. Returns the EventSource so the caller can close it. */
export function openStream(onEvent: (ev: StreamEvent) => void): EventSource {
  const source = new EventSource(api.streamUrl());
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as StreamEvent);
    } catch {
      /* ignore non-JSON frames (heartbeats etc.) */
    }
  };
  return source;
}
