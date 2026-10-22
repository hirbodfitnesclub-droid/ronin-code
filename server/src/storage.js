import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { timingSafeEqualStr } from './util.js';

/**
 * Receipt object storage — one contract, two backends.
 *
 * Production: Supabase Storage. Objects live in the PRIVATE bucket
 * `receipts` (migration 3) under keys `<userId>/<uuid>.<ext>`; uploads and
 * signed-URL minting use the service-role key, so receipts are never
 * publicly readable.
 *
 * Local dev/tests: no Storage service exists in the local stack, so objects
 * are files under cfg.receiptsDir with the SAME keys, and a "signed URL" is
 * an HMAC-signed path on the admin listener (`/admin-api/receipt-file`),
 * verified by the admin app before it streams the bytes. Same semantics:
 * short-lived, capability = the signature, no other access path.
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
    verifySignedParams() { return false; },
  };
}

// ── Local disk fallback ─────────────────────────────────────────────────────

function localStorage(cfg) {
  const root = path.resolve(cfg.receiptsDir);
  const fileFor = (key) => {
    const file = path.resolve(root, key);
    return file.startsWith(root + path.sep) ? file : null; // path-escape guard
  };
  const sign = (key, exp) => crypto.createHmac('sha256', cfg.authSecret).update(`${key}.${exp}`).digest('base64url');
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
    async signedUrls(keys, expiresInSec) {
      const exp = Math.floor(Date.now() / 1000) + expiresInSec;
      const out = new Map();
      for (const key of keys) {
        out.set(key, `/admin-api/receipt-file?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sign(key, exp)}`);
      }
      return out;
    },
    async read(key) {
      const file = fileFor(key);
      if (!file || !fs.existsSync(file)) return null;
      const buffer = await fs.promises.readFile(file);
      return { buffer, contentType: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
    },
    /** Verify a local signed URL's params (used by the admin receipt-file route). */
    verifySignedParams(key, exp, sig) {
      if (!key || !exp || !sig) return false;
      if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
      return timingSafeEqualStr(String(sig), sign(key, exp));
    },
  };
}
