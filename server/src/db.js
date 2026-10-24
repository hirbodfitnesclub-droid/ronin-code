import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres data layer (Supabase migration).
 *
 * The old synchronous node:sqlite handle is gone: every caller now awaits.
 * Money invariants do NOT live here — they are enforced inside the
 * SECURITY DEFINER RPC functions (supabase/migrations/20261022000002_rpc.sql).
 * This module is a thin, honest pool wrapper plus two cross-cutting helpers.
 */
export function createDb(cfg) {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not configured');
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax || 20 });
  if (cfg.dbSetRole) {
    // Cloud login roles (e.g. ronin_app) hold no BYPASSRLS themselves; every
    // pooled connection assumes the configured role (service_role) so RLS is
    // bypassed exactly as when connecting as postgres locally. Fail closed:
    // if SET ROLE fails the connection is discarded, never served as-is.
    if (!/^[a-z_][a-z0-9_]*$/.test(cfg.dbSetRole)) throw new Error('DB_SET_ROLE is not a plain role name');
    pool.on('connect', async (client) => {
      await client.query(`SET ROLE ${cfg.dbSetRole}`);
    });
  }
  pool.on('error', (e) => {
    // An idle client died (e.g. DB restart): the pool replaces it. Never crash.
    console.error(JSON.stringify({ level: 'error', scope: 'server', msg: 'pg_pool_error', error: e.message }));
  });
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    async one(text, params) {
      const r = await pool.query(text, params);
      return r.rows[0] ?? null;
    },
    async many(text, params) {
      const r = await pool.query(text, params);
      return r.rows;
    },
    /** Multi-statement transaction on a dedicated client (non-money flows). */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

/** Admin audit row (Liro admin_audit semantics): every sensitive admin action. */
export async function audit(db, actorPhone, action, target, meta) {
  await db.query(
    'INSERT INTO public.admin_audit (actor, action, target, meta) VALUES ($1,$2,$3,$4)',
    [actorPhone, action, target ?? null, meta ? JSON.stringify(meta) : null]);
}

/** Database server time as epoch ms — all expiry math is server-time only. */
export async function serverNowMs(db) {
  const row = await db.one('SELECT (extract(epoch FROM now()) * 1000)::bigint AS ms');
  return Number(row.ms);
}
