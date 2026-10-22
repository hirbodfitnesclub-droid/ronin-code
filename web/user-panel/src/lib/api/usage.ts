import type { CreditsResult, DayUsage, ModelUsage, UsageSummary } from './types';

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
