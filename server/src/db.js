import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- OTP codes: HMAC-hashed at rest (Liro otp_codes semantics)
CREATE TABLE IF NOT EXISTS otp_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'login',   -- login | admin_login
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, purpose, consumed, created_at);

-- Devices (one row per signed-in device of a user)
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- Refresh-token families: rotation + reuse detection live here
CREATE TABLE IF NOT EXISTS token_families (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  device_id     INTEGER NOT NULL REFERENCES devices(id),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id     INTEGER NOT NULL REFERENCES token_families(id),
  token_hash    TEXT NOT NULL UNIQUE,
  parent_id     INTEGER,
  replaced_by_id INTEGER,
  used_at       INTEGER,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  family_id  INTEGER NOT NULL REFERENCES token_families(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Admin sessions: a COMPLETELY separate domain from user sessions.
-- User access/refresh tokens are never consulted by the admin app, and
-- admin session tokens grant nothing on the user API.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Key/value settings (Liro semantics): card, packs, models, token_config
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Card-to-card purchase claims (Liro payments semantics, token-pack flavour)
CREATE TABLE IF NOT EXISTS orders (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  pack_id              TEXT NOT NULL,
  pack_title           TEXT NOT NULL,
  tokens               INTEGER NOT NULL,          -- snapshot at claim time
  price_rials          INTEGER NOT NULL,          -- snapshot at claim time
  received_amount_rials INTEGER,                  -- amount admin actually received
  payer_name           TEXT NOT NULL,
  card_last4           TEXT NOT NULL,
  reference            TEXT NOT NULL,             -- tracking code (شماره پیگیری)
  paid_at_text         TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  reject_reason        TEXT,
  admin_note           TEXT,
  reviewed_by          TEXT,
  reviewed_at          INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);

-- Append-only credit ledger. Balance is ALWAYS SUM(delta_tokens); never edited.
CREATE TABLE IF NOT EXISTS ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,   -- purchase|consume|hold|release|adjust|expire
  delta_tokens    INTEGER NOT NULL DEFAULT 0,
  amount_tokens   INTEGER,          -- for hold/release rows: the reserved amount
  balance_after   INTEGER,
  ref_type        TEXT,             -- order|hold|admin|system
  ref_id          TEXT,
  actor           TEXT,             -- user:<id> | admin:<phone> | system
  idempotency_key TEXT,
  request_id      TEXT,
  note            TEXT,
  meta            TEXT,             -- JSON
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

-- Credit lots: track expiry per grant (purchase / admin charge). FIFO consumption.
CREATE TABLE IF NOT EXISTS credit_lots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  source      TEXT NOT NULL,        -- order:<id> | admin | system
  tokens_total INTEGER NOT NULL,
  tokens_left INTEGER NOT NULL,
  expires_at  INTEGER,              -- NULL = never expires
  warned_at   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lots_user ON credit_lots(user_id, expires_at);

-- Metering holds (reserve → commit=consume / release)
CREATE TABLE IF NOT EXISTS holds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  request_id      TEXT NOT NULL,
  idempotency_key TEXT,
  model           TEXT NOT NULL,
  multiplier      REAL NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  actual_tokens   INTEGER,
  status          TEXT NOT NULL DEFAULT 'reserved',  -- reserved|committed|released
  response_json   TEXT,             -- stored upstream response for idempotent replay
  created_at      INTEGER NOT NULL,
  settled_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_idem ON holds(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holds_user_status ON holds(user_id, status);

-- Admin audit log (Liro admin_audit semantics): every sensitive admin action
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,         -- admin phone
  action     TEXT NOT NULL,
  target     TEXT,
  meta       TEXT,                  -- JSON
  created_at INTEGER NOT NULL
);

-- Sliding-window rate-limit events (Liro rate_events semantics)
CREATE TABLE IF NOT EXISTS rate_events (
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_events(key, created_at);
`;

export function openDb(cfg) {
  if (cfg.dbPath !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a BEGIN IMMEDIATE transaction (single-writer, race-safe). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export function audit(db, actorPhone, action, target, meta) {
  db.prepare('INSERT INTO admin_audit (actor, action, target, meta, created_at) VALUES (?,?,?,?,?)')
    .run(actorPhone, action, target ?? null, meta ? JSON.stringify(meta) : null, Date.now());
}
