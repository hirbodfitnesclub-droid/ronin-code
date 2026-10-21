import { tooMany } from './util.js';

/** Sliding-window rate limiting over the rate_events table (Liro semantics). */
export function hitRateLimit(db, key, limit, windowMs, nowMs = Date.now()) {
  const since = nowMs - windowMs;
  db.prepare('DELETE FROM rate_events WHERE created_at < ?').run(nowMs - 86_400_000);
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM rate_events WHERE key = ? AND created_at > ?').get(key, since);
  if (c >= limit) return false;
  db.prepare('INSERT INTO rate_events (key, created_at) VALUES (?,?)').run(key, nowMs);
  return true;
}

export function requireRateLimit(db, key, limit, windowMs, code = 'rate_limited') {
  if (!hitRateLimit(db, key, limit, windowMs)) throw tooMany(code, 'Too many requests, slow down.');
}

export function countInWindow(db, key, windowMs, nowMs = Date.now()) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM rate_events WHERE key = ? AND created_at > ?')
    .get(key, nowMs - windowMs);
  return c;
}
