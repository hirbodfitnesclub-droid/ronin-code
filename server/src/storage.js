import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Receipt object storage — one contract, two backends.
 *
 * Production: Supabase Storage. Objects live in the PRIVATE bucket
 * `receipts` (migration 3) under keys `<userId>/<uuid>.<ext>`; uploads and
 * signed-URL minting use the service-role key, so receipts are never
 * publicly readable.
 *
 * Local dev/tests: no Storage service exists in the local stack, so objects
 * are files under cfg.receiptsDir with the SAME keys; the admin app reads
 * the bytes back through `read()` and streams them itself. On Supabase the
 * admin app instead 302-redirects to a short-lived signed URL. Either way
 * receipts are never publicly readable.
 */

export const RECEIPTS_BUCKET = 'receipts';

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif',
};
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

export function receiptKey(userId, contentType) {
  return `${userId}/${crypto.randomUUID()}${EXT_BY_MIME[contentType] ?? '.bin'}`;
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function createStorage(cfg) {
  if (cfg.supabaseUrl && cfg.supabaseServiceRoleKey) return supabaseStorage(cfg);
  return localStorage(cfg);
}

// ── Supabase Storage (REST, service role) ───────────────────────────────────

function supabaseStorage(cfg) {
  const base = `${cfg.supabaseUrl}/storage/v1`;
  const headers = {
    apikey: cfg.supabaseServiceRoleKey,
    Authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
  };
  return {
    name: 'supabase',
    async put(key, buffer, contentType) {
      const res = await fetch(`${base}/object/${RECEIPTS_BUCKET}/${key}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: buffer,
      });
      if (!res.ok) throw new Error(`storage put failed: ${res.status} ${await res.text()}`);
      return key;
    },
    async remove(key) {
      await fetch(`${base}/object/${RECEIPTS_BUCKET}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [key] }),
      }).catch(() => {});
    },
    async signedUrls(keys, expiresInSec) {
      if (!keys.length) return new Map();
      const res = await fetch(`${base}/object/sign/${RECEIPTS_BUCKET}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec, paths: keys }),
      });
      if (!res.ok) throw new Error(`storage sign failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      const out = new Map();
      for (const row of rows) {
        if (row.path && row.signedURL) out.set(row.path, `${base}${row.signedURL}`);
      }
      return out;
    },
    async read() { return null; }, // bytes are served by Supabase via signed URLs, never through us
  };
}

// ── Local disk fallback ─────────────────────────────────────────────────────

function localStorage(cfg) {
  const root = path.resolve(cfg.receiptsDir);
  const fileFor = (key) => {
    const file = path.resolve(root, key);
    return file.startsWith(root + path.sep) ? file : null; // path-escape guard
  };
  return {
    name: 'local',
    async put(key, buffer) {
      const file = fileFor(key);
      if (!file) throw new Error('invalid receipt key');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buffer);
      return key;
    },
    async remove(key) {
      const file = fileFor(key);
      if (file) await fs.promises.rm(file, { force: true }).catch(() => {});
    },
    // No signed URLs on the local backend: the admin app streams the bytes
    // itself via read() (see GET /admin-api/orders/:id/receipt).
    async signedUrls() { return new Map(); },
    async read(key) {
      const file = fileFor(key);
      if (!file || !fs.existsSync(file)) return null;
      const buffer = await fs.promises.readFile(file);
      return { buffer, contentType: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
    },
  };
}
