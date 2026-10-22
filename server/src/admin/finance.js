import { sendJson, readJson } from '../http.js';
import { audit } from '../db.js';
import { badRequest, notFound, ms } from '../util.js';
import { requireCap } from './caps.js';

/**
 * Finance console (PRD §6.4) — deliberately WITHOUT bank-statement import /
 * reconciliation (owner decision, PRD §9.2): the owner approves money by hand
 * in the review queue; this console is the books on top of that truth:
 *   P&L     — income (approved claims, by received amount) − refunds − expenses
 *   Expenses— company costs, CRUD, capability `expense_write`
 *   Periods — named date ranges for reporting; closing is a marker, books
 *             stay readable (no data is ever frozen or hidden)
 *   Export  — CSV of the same lines, capability `export`
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** pg returns `date` columns as local-midnight Date objects — format locally. */
export function dateStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function parseRange(query) {
  const now = new Date();
  const from = query.get('from') || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = query.get('to') || now.toISOString().slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw badRequest('invalid_range', 'from/to must be yyyy-mm-dd with from ≤ to.');
  }
  return { from, to };
}

async function resolveRange(db, query) {
  const periodId = query.get('periodId');
  if (periodId) {
    const p = await db.one('SELECT * FROM public.finance_periods WHERE id = $1', [Number(periodId)]);
    if (!p) throw notFound('period_not_found', 'Finance period not found.');
    return { from: dateStr(p.starts_on), to: dateStr(p.ends_on), period: p };
  }
  return { ...parseRange(query), period: null };
}

async function pnl(db, { from, to }) {
  const income = Number((await db.one(
    `SELECT COALESCE(SUM(received_amount_rials),0)::bigint AS s FROM public.orders
     WHERE status IN ('approved','refunded') AND reviewed_at::date BETWEEN $1 AND $2`, [from, to])).s);
  const refunds = Number((await db.one(
    `SELECT COALESCE(SUM(amount_rials),0)::bigint AS s FROM public.order_refunds
     WHERE created_at::date BETWEEN $1 AND $2`, [from, to])).s);
  const expensesTotal = Number((await db.one(
    `SELECT COALESCE(SUM(amount_rials),0)::bigint AS s FROM public.expenses
     WHERE spent_on BETWEEN $1 AND $2`, [from, to])).s);
  const byCategory = (await db.many(
    `SELECT category, COALESCE(SUM(amount_rials),0)::bigint AS total FROM public.expenses
     WHERE spent_on BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [from, to]))
    .map((r) => ({ category: r.category, totalRials: Number(r.total) }));
  const daily = await db.many(
    `SELECT d::date AS day,
       (SELECT COALESCE(SUM(received_amount_rials),0) FROM public.orders
         WHERE status IN ('approved','refunded') AND reviewed_at::date = d::date) AS income,
       (SELECT COALESCE(SUM(amount_rials),0) FROM public.expenses
         WHERE spent_on = d::date) AS expenses
     FROM generate_series($1::date, $2::date, interval '1 day') AS d ORDER BY d`, [from, to]);
  return {
    from, to,
    incomeRials: income, refundRials: refunds, expenseRials: expensesTotal,
    netRials: income - refunds - expensesTotal,
    expensesByCategory: byCategory,
    daily: daily.map((r) => ({
      date: dateStr(r.day),
      incomeRials: Number(r.income), expenseRials: Number(r.expenses),
    })),
  };
}

const publicExpense = (e) => ({
  id: Number(e.id), amountRials: Number(e.amount_rials), category: e.category,
  note: e.note, spentOn: dateStr(e.spent_on),
  actor: e.actor, createdAt: ms(e.created_at), updatedAt: ms(e.updated_at),
});

const publicPeriod = (p) => ({
  id: Number(p.id), title: p.title,
  startsOn: dateStr(p.starts_on),
  endsOn: dateStr(p.ends_on),
  closedAt: ms(p.closed_at), closedBy: p.closed_by, createdBy: p.created_by, createdAt: ms(p.created_at),
});

function validateExpense(body) {
  const amount = Number(body.amountRials);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('invalid_amount', 'amountRials must be a positive integer.');
  const category = String(body.category ?? '').trim();
  if (!category || category.length > 60) throw badRequest('invalid_category', 'category is required (max 60 chars).');
  const spentOn = body.spentOn ? String(body.spentOn) : new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(spentOn)) throw badRequest('invalid_date', 'spentOn must be yyyy-mm-dd.');
  return { amount, category, note: body.note ? String(body.note).slice(0, 500) : null, spentOn };
}

export function registerFinanceRoutes(router, { db, cfg, guard }) {
  router.get('/admin-api/finance/pnl', async (req, res, { query }) => {
    const session = await guard(req);
    await requireCap(db, cfg, session, 'finance_view');
    const range = await resolveRange(db, query);
    sendJson(res, 200, { pnl: await pnl(db, range), period: range.period ? publicPeriod(range.period) : null });
  });

  router.get('/admin-api/finance/expenses', async (req, res, { query }) => {
    const session = await guard(req);
    await requireCap(db, cfg, session, 'finance_view');
    const { from, to } = parseRange(query);
    const rows = await db.many(
      'SELECT * FROM public.expenses WHERE spent_on BETWEEN $1 AND $2 ORDER BY spent_on DESC, id DESC LIMIT 500',
      [from, to]);
    sendJson(res, 200, { expenses: rows.map(publicExpense) });
  });

  router.post('/admin-api/finance/expenses', async (req, res) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'expense_write');
    const v = validateExpense(await readJson(req));
    const row = await db.one(
      'INSERT INTO public.expenses (amount_rials, category, note, spent_on, actor) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [v.amount, v.category, v.note, v.spentOn, session.phone]);
    await audit(db, session.phone, 'expense_created', `expense:${row.id}`, { amountRials: v.amount, category: v.category });
    sendJson(res, 201, { expense: publicExpense(row) });
  });

  router.put('/admin-api/finance/expenses/:id', async (req, res, { params }) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'expense_write');
    const v = validateExpense(await readJson(req));
    const row = await db.one(
      'UPDATE public.expenses SET amount_rials = $2, category = $3, note = $4, spent_on = $5, updated_at = now() WHERE id = $1 RETURNING *',
      [Number(params.id), v.amount, v.category, v.note, v.spentOn]);
    if (!row) throw notFound('expense_not_found', 'Expense not found.');
    await audit(db, session.phone, 'expense_updated', `expense:${row.id}`, { amountRials: v.amount, category: v.category });
    sendJson(res, 200, { expense: publicExpense(row) });
  });

  router.delete('/admin-api/finance/expenses/:id', async (req, res, { params }) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'expense_write');
    const row = await db.one('DELETE FROM public.expenses WHERE id = $1 RETURNING *', [Number(params.id)]);
    if (!row) throw notFound('expense_not_found', 'Expense not found.');
    await audit(db, session.phone, 'expense_deleted', `expense:${row.id}`, { amountRials: Number(row.amount_rials) });
    sendJson(res, 200, { ok: true });
  });

  router.get('/admin-api/finance/periods', async (req, res) => {
    const session = await guard(req);
    await requireCap(db, cfg, session, 'finance_view');
    const rows = await db.many('SELECT * FROM public.finance_periods ORDER BY starts_on DESC, id DESC');
    sendJson(res, 200, { periods: rows.map(publicPeriod) });
  });

  router.post('/admin-api/finance/periods', async (req, res) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'policy_write');
    const body = await readJson(req);
    const title = String(body.title ?? '').trim();
    if (!title || title.length > 80) throw badRequest('invalid_title', 'title is required (max 80 chars).');
    if (!DATE_RE.test(String(body.startsOn ?? '')) || !DATE_RE.test(String(body.endsOn ?? '')) || body.startsOn > body.endsOn) {
      throw badRequest('invalid_range', 'startsOn/endsOn must be yyyy-mm-dd with startsOn ≤ endsOn.');
    }
    const row = await db.one(
      'INSERT INTO public.finance_periods (title, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [title, body.startsOn, body.endsOn, session.phone]);
    await audit(db, session.phone, 'period_created', `period:${row.id}`, { title });
    sendJson(res, 201, { period: publicPeriod(row) });
  });

  router.post('/admin-api/finance/periods/:id/close', async (req, res, { params }) => {
    const session = await guard(req, { mutate: true });
    await requireCap(db, cfg, session, 'policy_write');
    const row = await db.one(
      'UPDATE public.finance_periods SET closed_at = now(), closed_by = $2 WHERE id = $1 AND closed_at IS NULL RETURNING *',
      [Number(params.id), session.phone]);
    if (!row) throw notFound('period_not_found', 'Period not found or already closed.');
    await audit(db, session.phone, 'period_closed', `period:${row.id}`, null);
    sendJson(res, 200, { period: publicPeriod(row) });
  });

  router.get('/admin-api/finance/export.csv', async (req, res, { query }) => {
    const session = await guard(req);
    await requireCap(db, cfg, session, 'export');
    const { from, to } = parseRange(query);
    const lines = [['date', 'type', 'description', 'amount_rials']];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const income = await db.many(
      `SELECT reviewed_at::date AS d, id, pack_title, received_amount_rials AS amount FROM public.orders
       WHERE status IN ('approved','refunded') AND reviewed_at::date BETWEEN $1 AND $2 ORDER BY reviewed_at`, [from, to]);
    for (const r of income) lines.push([dateStr(r.d), 'income', `order #${r.id} ${r.pack_title}`, r.amount]);
    const refunds = await db.many(
      `SELECT created_at::date AS d, order_id, reason, amount_rials FROM public.order_refunds
       WHERE created_at::date BETWEEN $1 AND $2 ORDER BY created_at`, [from, to]);
    for (const r of refunds) lines.push([dateStr(r.d), 'refund', `order #${r.order_id} ${r.reason}`, -Number(r.amount_rials)]);
    const expenses = await db.many(
      'SELECT spent_on AS d, category, note, amount_rials FROM public.expenses WHERE spent_on BETWEEN $1 AND $2 ORDER BY spent_on', [from, to]);
    for (const r of expenses) lines.push([dateStr(r.d), 'expense', `${r.category}${r.note ? ' — ' + r.note : ''}`, -Number(r.amount_rials)]);
    await audit(db, session.phone, 'finance_exported', 'finance', { from, to, rows: lines.length - 1 });
    const csv = '﻿' + lines.map((l) => l.map(esc).join(',')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ronin-finance-${from}-to-${to}.csv"`,
    });
    res.end(csv);
  });
}
