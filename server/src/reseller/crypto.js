import crypto from 'node:crypto';
import { sha256Hex } from '../util.js';

/**
 * Delegated-key encryption at rest — design §2.3.
 * AES-256-GCM, fresh 12-byte IV per encryption, AAD = `<userId>:<keyRowId>`
 * (a ciphertext copied into another user's row fails authentication).
 * Stored format: `v1:<b64 iv>:<b64 authTag>:<b64 ciphertext>`.
 * The 32-byte key comes ONLY from env CVC_KEY_ENCRYPTION_KEY (cfg) and is
 * never logged, stored in the DB, or sent anywhere.
 */

export function decodeEncryptionKey(cfg) {
  const raw = cfg?.cvcKeyEncryptionKey;
  if (!raw) return null;
  try {
    const buf = Buffer.from(String(raw), 'base64');
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}

export function encryptionReady(cfg) {
  return decodeEncryptionKey(cfg) !== null;
}

export function encryptDelegatedKey(cfg, plaintext, { userId, keyRowId }) {
  const key = decodeEncryptionKey(cfg);
  if (!key) throw new Error('cvc_key_encryption_key_invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${userId}:${keyRowId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptDelegatedKey(cfg, stored, { userId, keyRowId }) {
  const key = decodeEncryptionKey(cfg);
  if (!key) throw new Error('cvc_key_encryption_key_invalid');
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('ciphertext_format_invalid');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`${userId}:${keyRowId}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const fingerprintOf = (plaintext) => sha256Hex(String(plaintext));
export const last4Of = (plaintext) => String(plaintext).slice(-4);
