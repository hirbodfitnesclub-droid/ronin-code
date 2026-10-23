import type {
  CreditsResult,
  DayUsage,
  ModelUsage,
  ProviderKeySummary,
  RecentUsageResult,
  RecentUsageRow,
  RoutingMode,
  UsageSummary,
} from './types';

/* ── Phase 2 routing helpers (design §7.1/§7.3, contradiction C6) ───────
   In per-user mode the ledger stops gaining 'consume' rows, so deriving the
   dashboard from /api/credits would silently flatline. The live client must
   branch on routingMode: per-user → GET /api/usage/summary (built server-side
   from key_usage_daily rollups); shared → deriveUsage below, unchanged. */
export function isPerUserMode(mode: RoutingMode | null | undefined): boolean {
  return mode === 'per_user';
}

/** §7.1: a stale provider balance is displayable for up to 24h; beyond that
    the panel must show "balance unavailable" instead of a wrong number. */
export const BALANCE_STALE_LIMIT_MS = 24 * 3_600_000;

export function isProviderBalanceUnavailable(
  providerKey: ProviderKeySummary | null | undefined,
  now = new Date(),
): boolean {
  if (!providerKey?.balanceStale) return false;
  if (!providerKey.balanceObservedAt) return false;
  const observed = new Date(providerKey.balanceObservedAt).getTime();
  if (Number.isNaN(observed)) return false;
  return now.getTime() - observed > BALANCE_STALE_LIMIT_MS;
}

/** Normalise a raw GET /api/usage/recent payload. Defensive by design: the
    provider hard-caps at 30 rows, so anything beyond 30 is dropped, and
    malformed rows are skipped rather than crashing the History screen. */
export function mapRecentUsage(raw: unknown): RecentUsageResult {
  const body = (raw ?? {}) as { rows?: unknown; totalRequests?: unknown; windowNote?: unknown };
  const rowsIn = Array.isArray(body.rows) ? body.rows : [];
  const rows: RecentUsageRow[] = [];
  for (const r of rowsIn.slice(0, 30)) {
    const row = r as Partial<RecentUsageRow>;
    if (typeof row?.model !== 'string' || typeof row?.createdAt !== 'string') continue;
    rows.push({
      model: redactKeyMaterial(row.model),
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cachedTokens: Number(row.cachedTokens) || 0,
      costTokens: Number(row.costTokens) || 0,
      fast: row.fast === true,
      status: typeof row.status === 'string' ? redactKeyMaterial(row.status) : 'success',
      createdAt: row.createdAt,
    });
  }
  return {
    rows,
    totalRequests: Number(body.totalRequests) || rows.length,
    windowNote: typeof body.windowNote === 'string' ? body.windowNote : 'recent_30',
  };
}

/** Masked key hint for display: '•••• 9f3k'. Only last-4 ever exists client-side.
    DEFENSIVE (tech-lead battery): even if a misbehaving API returned a FULL key
    in this field, only its last 4 chars can ever be rendered. */
export function maskedKeyHint(keyLast4: string | null | undefined): string | null {
  if (!keyLast4) return null;
  const last4 = keyLast4.replace(/^…+/, '').slice(-4);
  return last4 ? `•••• ${last4}` : null;
}

/** Full-key pattern (provider-style secrets). Used by redaction + tests. */
export const FULL_KEY_PATTERN = /sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g;

/** Redact any full-key material embedded in free text (notes, reasons, actor
    strings) before it reaches the DOM. Applied at component boundaries to
    every server-supplied free-text field a key could hide in. */
export function redactKeyMaterial(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(FULL_KEY_PATTERN, (m) => `•••• ${m.slice(-4)}`);
}

/** Every display string the dashboard's provider-key summary renders, built
    in ONE place so tests can assert on the exact rendered content. The hint
    is masked here — the component never touches the raw field. */
export interface ProviderKeySummaryView {
  status: ProviderKeySummary['status'];
  issuedTokens: number;
  hint: string | null;
}

export function buildProviderKeySummaryView(
  providerKey: ProviderKeySummary | null | undefined,
): ProviderKeySummaryView | null {
  if (!providerKey) return null;
  return {
    status: providerKey.status,
    issuedTokens: providerKey.tokenLimitIssued,
    hint: maskedKeyHint(providerKey.keyLast4),
  };
}

/* Derive dashboard aggregates from /api/credits ledger rows (live mode).
   Only 'consume' rows (deltaTokens < 0) count as usage. Balance itself is
   NEVER derived here — it comes from the credits/me/status responses. */
export function deriveUsage(credits: CreditsResult, now = new Date()): UsageSummary {
  const consume = credits.ledger.filter((r) => r.kind === 'consume');
  const sameDay = (iso: string, d: Date) => {
    const x = new Date(iso);
    return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
  };
  let todayTokens = 0;
  let monthTokens = 0;
  const byDay = new Map<string, number>();
  const byModel = new Map<string, ModelUsage>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of consume) {
    const used = Math.abs(row.deltaTokens || row.amountTokens);
    const d = new Date(row.createdAt);
    if (sameDay(row.createdAt, now)) todayTokens += used;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) monthTokens += used;
    const key = d.toISOString().slice(0, 10);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + used);
    if (row.model) {
      const cur = byModel.get(row.model) ?? { model: row.model, tokens: 0, multiplier: row.multiplier };
      cur.tokens += used;
      byModel.set(row.model, cur);
    }
  }
  const last7Days: DayUsage[] = [...byDay.entries()].map(([date, tokens]) => ({ date, tokens }));
  const topModels = [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return { todayTokens, monthTokens, last7Days, topModels };
}
