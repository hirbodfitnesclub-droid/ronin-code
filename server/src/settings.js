/**
 * Settings store — Liro semantics: a key/value table of JSON documents,
 * admin-editable at runtime: `card` (merchant card-to-card target),
 * `packs` (token packs), `models` (per-model multipliers), `token_config`.
 * Defaults are seeded from env on first read.
 */

const DEFAULT_MODELS = [
  { model: 'deepseek-v4.1-flash', multiplier: 0.1 },
  { model: 'gpt-4o-mini', multiplier: 0.5 },
  { model: 'gpt-4o', multiplier: 2 },
  { model: 'claude-sonnet-4-5', multiplier: 3 },
];

const DEFAULT_PACKS = [
  { id: 'pack-1', title: 'بسته ۱ دلاری', usd: 1, priceRials: 0, validityDays: null, badge: null },
  { id: 'pack-5', title: 'بسته ۵ دلاری', usd: 5, priceRials: 0, validityDays: null, badge: 'پیشنهاد ما' },
  { id: 'pack-20', title: 'بسته ۲۰ دلاری', usd: 20, priceRials: null, validityDays: null, badge: null },
];

export function getSetting(db, cfg, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return JSON.parse(row.value);
  const seeded = seedDefault(cfg, key);
  if (seeded !== undefined) setSetting(db, key, seeded);
  return seeded;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
  return value;
}

function seedDefault(cfg, key) {
  switch (key) {
    case 'card': return { ...cfg.shopCard };
    case 'packs': return DEFAULT_PACKS;
    case 'models': return DEFAULT_MODELS;
    case 'token_config': return { tokensPerUsd: cfg.tokensPerUsd, defaultMultiplier: 1 };
    default: return undefined;
  }
}

export function getPacks(db, cfg) {
  const { tokensPerUsd } = getSetting(db, cfg, 'token_config');
  return getSetting(db, cfg, 'packs').map((p) => ({ ...p, tokens: Math.round(p.usd * tokensPerUsd) }));
}

export function getPack(db, cfg, packId) {
  return getPacks(db, cfg).find((p) => p.id === packId) ?? null;
}

export function getCard(db, cfg) {
  return getSetting(db, cfg, 'card');
}

/** Per-model multiplier table — server-side only; the client only ever displays it. */
export function getMultiplier(db, cfg, model) {
  const models = getSetting(db, cfg, 'models');
  const hit = models.find((m) => m.model === model);
  if (hit) return Number(hit.multiplier);
  return Number(getSetting(db, cfg, 'token_config').defaultMultiplier ?? 1);
}

export function getModels(db, cfg) {
  return getSetting(db, cfg, 'models');
}
