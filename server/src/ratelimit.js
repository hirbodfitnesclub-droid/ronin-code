import { tooMany } from './util.js';

/**
 * Sliding-window rate limiting over the rate_events table (Liro semantics).
 * Windows are computed with the DATABASE clock — server time only.
 */
export async function hitRateLimit(db, key, limit, windowMs) {
  await db.query("DELETE FROM public.rate_events WHERE created_at < now() - interval '24 hours'");
  const row = await db.one(
    "SELECT count(*)::int AS c FROM public.rate_events WHERE key = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')",
    [key, windowMs]);
  if (row.c >= limit) return false;
  await db.query('INSERT INTO public.rate_events (key) VALUES ($1)', [key]);
  return true;
}

export async function requireRateLimit(db, key, limit, windowMs, code = 'rate_limited') {
  if (!(await hitRateLimit(db, key, limit, windowMs))) throw tooMany(code, 'Too many requests, slow down.');
}

export async function countInWindow(db, key, windowMs) {
  const row = await db.one(
    "SELECT count(*)::int AS c FROM public.rate_events WHERE key = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')",
    [key, windowMs]);
  return row.c;
}

/** Transaction-scoped variants for check-then-act flows (see auth.requestOtp). */
export async function countInWindowOn(client, key, windowMs) {
  const r = await client.query(
    "SELECT count(*)::int AS c FROM public.rate_events WHERE key = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')",
    [key, windowMs]);
  return r.rows[0].c;
}

export async function recordHitOn(client, key) {
  await client.query('INSERT INTO public.rate_events (key) VALUES ($1)', [key]);
}
