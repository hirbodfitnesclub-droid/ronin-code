/**
 * Build-time sync for the Vercel admin function: copies the dependency-light
 * server sources (server/src) into api/_lib/server so api/index.js can import
 * the admin handler without any monorepo path tricks at runtime.
 *
 * The copy is a build artifact — api/_lib/ is git-ignored (see .gitignore)
 * and regenerated on every `npm run build`. Run it explicitly before local
 * smoke tests: `node scripts/sync-api.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.resolve(SCRIPT_DIR, '..');
const SRC = path.resolve(SCRIPT_DIR, '../../../server/src');
const DEST = path.join(PANEL_DIR, 'api', '_lib', 'server');

if (!fs.existsSync(SRC)) {
  console.error(`sync-api: server sources not found at ${SRC}`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });
console.log(`sync-api: copied server/src -> ${path.relative(PANEL_DIR, DEST)}`);
