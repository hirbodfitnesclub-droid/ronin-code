import { sendJson, readJson } from '../http.js';
import { audit } from '../db.js';
import { badRequest, HttpError } from '../util.js';
import { requireCap } from './caps.js';
import { dateStr } from './finance.js';

/**
 * Analytics centre (PRD §6.6): dashboards computed from the real books
 * (users, orders, ledger, holds) + the AI ANALYST chat.
 *
 * The analyst is ON-DEMAND ONLY (owner decision, PRD §9.3): nothing here is
 * scheduled, there is no cron and no daily report — an admin asks, the server
 * assembles a compact aggregate context and calls the cheap OpenAI-compatible
 * gateway. The gateway key is server-side only and never reaches the browser.
 */

export async function analyticsOverview(db, days = 30) {
  const daily = await db.many(
    `SELECT d::date AS day,
       (SELECT count(*) FROM public.users WHERE (created_at AT TIME ZONE 'Asia/Tehran')::date = d::date) AS new_users,
       (SELECT COALESCE(SUM(received_amount_rials),0) FROM public.orders
         WHERE status IN ('approved','refunded') AND (reviewed_at AT TIME ZONE 'Asia/Tehran')::date = d::date) AS revenue,
       (SELECT COALESCE(-SUM(delta_tokens),0) FROM public.ledger
         WHERE kind = 'consume' AND (created_at AT TIME ZONE 'Asia/Tehran')::date = d::date) AS consumed
     FROM generate_series((now() AT TIME ZONE 'Asia/Tehran')::date - ($1 - 1), (now() AT TIME ZONE 'Asia/Tehran')::date, interval '1 day') AS d ORDER BY d`,
    [days]);
  let runningUsers = Number((await db.one(
    `SELECT count(*)::int AS c FROM public.users WHERE (created_at AT TIME ZONE 'Asia/Tehran')::date < (now() AT TIME ZONE 'Asia/Tehran')::date - ($1 - 1)`, [days])).c);
  const series = daily.map((r) => {
    runningUsers += Number(r.new_users);
    return {
      date: dateStr(r.day),
      newUsers: Number(r.new_users), totalUsers: runningUsers,
      revenueRials: Number(r.revenue), consumedTokens: Number(r.consumed),
    };
  });

  const topModels = (await db.many(
    `SELECT model, COALESCE(SUM(actual_tokens),0)::bigint AS tokens, count(*)::int AS requests
     FROM public.holds WHERE status = 'committed' GROUP BY model ORDER BY tokens DESC LIMIT 10`))
    .map((r) => ({ model: r.model, tokens: Number(r.tokens), requests: r.requests }));

  const claimRows = await db.many('SELECT status, count(*)::int AS c FROM public.orders GROUP BY status');
  const claims = { pending: 0, approved: 0, rejected: 0, refunded: 0 };
  for (const r of claimRows) claims[r.status] = r.c;
  const decided = claims.approved + claims.refunded + claims.rejected;
  const totals = {
    users: Number((await db.one('SELECT count(*)::int AS c FROM public.users')).c),
    revenueRials: Number((await db.one(
      "SELECT COALESCE(SUM(received_amount_rials),0)::bigint AS s FROM public.orders WHERE status IN ('approved','refunded')")).s),
    consumedTokens: Number((await db.one(
      "SELECT COALESCE(-SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind = 'consume'")).s),
    grantedTokens: Number((await db.one(
      "SELECT COALESCE(SUM(delta_tokens),0)::bigint AS s FROM public.ledger WHERE kind IN ('purchase','adjust') AND delta_tokens > 0")).s),
  };
  return {
    days, series, topModels,
    claims: { ...claims, approvalRate: decided ? Math.round(((claims.approved + claims.refunded) / decided) * 1000) / 10 : null },
    totals,
  };
}

const ANALYST_SYSTEM = `تو «تحلیل‌گر هوش مصنوعی» پنل مدیریت رونین کد هستی. بر اساس داده‌های تجمیعی زیر (JSON) به پرسش مدیر پاسخ بده.
قواعد: پاسخ فارسی، کوتاه و عدد‌محور؛ فقط از همین داده‌ها نتیجه بگیر و اگر داده‌ای برای پاسخ کافی نیست صریح بگو؛ هیچ دادهٔ شخصی (شماره تلفن و…) در داده‌ها نیست و نباید حدس بزنی. مبالغ ریالی‌اند و موجودی‌ها توکن.`;

export function registerAnalyticsRoutes(router, { db, cfg, guard }) {
  router.get('/admin-api/analytics/overview', async (req, res, { query }) => {
    const session = await guard(req);
    await requireCap(db, cfg, session, 'finance_view');
    const days = Math.min(Math.max(Number(query.get('days') || 30), 7), 90);
    sendJson(res, 200, await analyticsOverview(db, days));
  });

  router.post('/admin-api/analyst/chat', async (req, res) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'finance_view');
    if (!cfg.analystBaseUrl || !cfg.analystApiKey) {
      throw new HttpError(503, 'analyst_not_configured', 'Analyst gateway is not configured (ANALYST_* / UPSTREAM_* env).');
    }
    const body = await readJson(req);
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const history = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== 'user') {
      throw badRequest('invalid_messages', 'messages must end with a user question.');
    }

    const overview = await analyticsOverview(db, 30);
    const month = await db.one(
      `SELECT COALESCE(SUM(amount_rials),0)::bigint AS s FROM public.expenses
       WHERE spent_on >= date_trunc('month', current_date)::date`);
    // Phase 2 provider figures (§7.4): observed, not booked — the ledger
    // totals above remain the financial truth.
    let providerContext = null;
    try {
      const keyAgg = await db.one(
        `SELECT
           count(*) FILTER (WHERE status = 'active')::int AS active,
           count(*) FILTER (WHERE status = 'frozen')::int AS frozen,
           count(*) FILTER (WHERE status = 'needs_attention')::int AS needs_attention,
           COALESCE(SUM(tokens_used_observed),0)::bigint AS used_observed,
           (SELECT balance_observed FROM public.user_provider_keys WHERE balance_observed IS NOT NULL ORDER BY balance_observed_at DESC LIMIT 1) AS any_balance
         FROM public.user_provider_keys`);
      const drift = await db.one(
        "SELECT count(*)::int AS c FROM public.risk_flags WHERE kind = 'provider_drift' AND status = 'open'");
      const poolAudit = await db.one(
        "SELECT meta FROM public.admin_audit WHERE action = 'provider_pool_low' ORDER BY id DESC LIMIT 1");
      providerContext = {
        providerKeys: {
          active: keyAgg.active, frozen: keyAgg.frozen, needsAttention: keyAgg.needs_attention,
          openDriftFlags: drift.c,
        },
        providerTokensUsedObserved: Number(keyAgg.used_observed),
        poolBalanceObserved: poolAudit?.meta?.poolObserved ?? null,
      };
    } catch { /* tables exist from migration 00007; absence must not break the analyst */ }
    const context = {
      generatedAt: new Date().toISOString(),
      totals: overview.totals,
      claims: overview.claims,
      topModels: overview.topModels,
      last30Days: overview.series,
      expensesThisMonthRials: Number(month.s),
      ...(providerContext ? providerContext : {}),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    let reply;
    try {
      const r = await fetch(`${cfg.analystBaseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.analystApiKey}` },
        body: JSON.stringify({
          model: cfg.analystModel,
          messages: [
            { role: 'system', content: `${ANALYST_SYSTEM}\n\nداده‌ها:\n${JSON.stringify(context)}` },
            ...history,
          ],
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new HttpError(502, 'analyst_upstream_error', `Analyst gateway returned ${r.status}.`);
      reply = data?.choices?.[0]?.message?.content;
      if (!reply) throw new HttpError(502, 'analyst_empty_reply', 'Analyst gateway returned an empty reply.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'analyst_unreachable', `Analyst gateway unreachable: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    await audit(db, session.phone, 'analyst_asked', 'analyst', { model: cfg.analystModel });
    sendJson(res, 200, { reply, model: cfg.analystModel });
  });
}
