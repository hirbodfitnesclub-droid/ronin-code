/* ------------------------------------------------------------------ */
/*  Ronin Code — API layer (contract v1)                               */
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

export interface Provider {
  id: string;
  label: string;
  defaultModel: string;
  hasKey: boolean;
  maskedKey: string;
  baseUrl?: string;
}

export interface Status {
  mode: Mode;
  provider: string;
  model: string;
  hasKey: boolean;
  project: string;
}

export interface ChangedFile {
  path: string;
  action: string; // "created" | "modified" | … (host-defined)
}

export type ActivityKind =
  | 'planning'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'editing'
  | 'terminal'
  | 'searching'
  | 'reviewing';

export type StreamEvent =
  | { type: 'activity_start'; activityId: string; kind: ActivityKind }
  | { type: 'activity_end'; activityId: string; kind?: ActivityKind }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'changes'; files: ChangedFile[] }
  | { type: 'turn_done' }
  | { type: 'turn_error'; message: string };

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
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message || body.error || '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => get<{ ok: boolean }>('/health'),

  providers: () => get<Provider[]>('/api/providers'),

  status: () => get<Status>('/api/status'),

  saveSettings: (body: { provider: string; apiKey?: string; model?: string; baseUrl?: string }) =>
    post<unknown>('/api/settings', body),

  testSettings: (provider: string, baseUrl?: string) =>
    post<{ ok: boolean; message: string }>('/api/settings/test', { provider, ...(baseUrl ? { baseUrl } : {}) }),

  selectProject: (path: string) =>
    post<{ path: string }>('/api/projects/select', { path }),

  starterProject: () => post<{ path: string }>('/api/projects/starter'),

  startTurn: (prompt: string) =>
    post<{ ok: boolean; turnId: string }>('/api/turn', { prompt }),

  undo: () => post<{ ok: boolean; files: ChangedFile[] }>('/api/undo'),

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
