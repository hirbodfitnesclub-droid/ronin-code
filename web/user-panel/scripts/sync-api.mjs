// Build-time code sync: copy the dependency-light server source into
// api/_lib/server so the Vercel function (api/index.js) can import it.
// The copy is fresh on every run and is git-ignored (api/_lib/) — the
// canonical source stays in ../../../server/src.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../../server/src');
const dest = path.resolve(here, '../api/_lib/server');

if (!fs.existsSync(src)) {
  throw new Error(`sync-api: server source not found at ${src}`);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`sync-api: copied ${src} -> ${dest}`);
