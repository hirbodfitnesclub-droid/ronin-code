/**
 * Local PostgreSQL runtime for development and tests.
 *
 * There is no Docker in this environment, so the dev stack runs GENUINE
 * PostgreSQL binaries (the zonky builds shipped by the `@embedded-postgres`
 * npm packages — the same binaries Maven's embedded-postgres distributes)
 * directly as the `postgres` system user. The SQL spoken is 100% stock
 * PostgreSQL — identical to what Supabase Cloud runs — so migrations behave
 * the same locally and in production.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function sourceNativeDir() {
  const fromModules = path.join(SERVER_DIR, 'node_modules', '@embedded-postgres', 'linux-x64', 'native');
  if (fs.existsSync(path.join(fromModules, 'bin', 'initdb'))) return fromModules;
  throw new Error('PostgreSQL binaries not found. Run `npm install` in server/ (devDependency @embedded-postgres/linux-x64) or set RONIN_PG_BIN.');
}

let stagedBinDir = null;
/**
 * Directory containing initdb/pg_ctl/postgres, executable by the `postgres`
 * user. When running as root, the binaries are staged once into /var/tmp:
 * node_modules inside a private home directory is not traversable by other
 * users, and Postgres refuses to run as root.
 */
export function pgBinDir() {
  if (process.env.RONIN_PG_BIN) return process.env.RONIN_PG_BIN;
  if (!isRoot()) return path.join(sourceNativeDir(), 'bin');
  if (stagedBinDir) return stagedBinDir;
  const staged = '/var/tmp/ronin-pg-bin';
  if (!fs.existsSync(path.join(staged, 'bin', 'initdb'))) {
    fs.mkdirSync(staged, { recursive: true });
    execFileSync('cp', ['-r', `${sourceNativeDir()}/.`, staged]);
    execFileSync('chmod', ['-R', 'a+rX', staged]);
  }
  stagedBinDir = path.join(staged, 'bin');
  return stagedBinDir;
}

/** The `postgres` system user may not exist (fresh VM): create it on demand. */
function ensurePostgresUser() {
  if (!isRoot()) return;
  try { execFileSync('id', ['postgres'], { stdio: 'ignore' }); }
  catch { execFileSync('useradd', ['--system', '--shell', '/usr/sbin/nologin', 'postgres']); }
}

/** Postgres refuses to run as root: run server binaries as `postgres`. */
function pgCmd(bin, args) {
  if (!isRoot()) return [bin, args];
  ensurePostgresUser();
  return ['runuser', ['-u', 'postgres', '--', bin, ...args]];
}

async function execPg(binName, args, opts = {}) {
  const [cmd, fullArgs] = pgCmd(path.join(pgBinDir(), binName), args);
  return run(cmd, fullArgs, opts);
}

function chownToPostgres(dir) {
  if (isRoot()) execFileSync('chown', ['-R', 'postgres:postgres', dir]);
}

/**
 * Start a Postgres instance on 127.0.0.1:<port> with trust auth (local only).
 * Initialises the data directory on first use. Returns { stop, port, url }.
 */
export async function startPostgres({ dataDir, port }) {
  ensurePostgresUser(); // must precede the chowns below
  const runDir = `${dataDir}-run`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  if (isRoot()) {
    // The caller-created parent (e.g. an mkdtemp dir, mode 0700) must be
    // traversable/owned by postgres or initdb cannot reach the data dir.
    execFileSync('chown', ['postgres:postgres', path.dirname(dataDir)]);
    execFileSync('chmod', ['0755', path.dirname(dataDir)]);
  }
  chownToPostgres(dataDir);
  chownToPostgres(runDir);
  fs.chmodSync(dataDir, 0o700);

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await execPg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
  }
  const logFile = path.join(runDir, 'postgres.log');
  await execPg('pg_ctl', [
    '-D', dataDir,
    '-o', `-p ${port} -k ${runDir} -c listen_addresses=127.0.0.1`,
    '-l', logFile, '-w', '-t', '30', 'start',
  ]);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const reachable = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (reachable) break;
    if (Date.now() > deadline) {
      try { await execPg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']); } catch { /* ignore */ }
      throw new Error(`Postgres did not become ready; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    port,
    host: '127.0.0.1',
    url: (db) => `postgres://postgres@127.0.0.1:${port}/${db}`,
    async stop() {
      try { await execPg('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']); } catch { /* already down */ }
    },
  };
}
