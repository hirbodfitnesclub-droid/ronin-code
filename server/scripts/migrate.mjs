/**
 * Migration runner.
 *
 * Local stacks:  node scripts/migrate.mjs --local   (DATABASE_URL = superuser)
 *   Applies supabase/local/00_prereqs.sql first (roles/auth schema/search_path
 *   that Supabase Cloud provides out of the box), then supabase/migrations/*.
 *
 * Supabase Cloud: do NOT use this script — apply supabase/migrations/* with
 * the Supabase CLI (`supabase db push`) or the dashboard SQL editor instead.
 * The SQL is identical; only the tracking differs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const MIGRATIONS_DIR = path.join(REPO_DIR, 'supabase', 'migrations');
const PREREQS_FILE = path.join(REPO_DIR, 'supabase', 'local', '00_prereqs.sql');

export async function applyLocalPrereqs(client) {
  await client.query(fs.readFileSync(PREREQS_FILE, 'utf8'));
}

export async function applyMigrations(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS public.ronin_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    const seen = await client.query('SELECT 1 FROM public.ronin_migrations WHERE filename = $1', [file]);
    if (seen.rowCount) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.ronin_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${file} failed: ${e.message}`);
    }
    applied.push(file);
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (process.argv.includes('--local')) {
      await applyLocalPrereqs(client);
      console.log('local prereqs applied');
    }
    const applied = await applyMigrations(client);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
  } finally {
    await client.end();
  }
}
