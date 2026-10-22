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

export async function getSetting(db, cfg, key) {
  const row = await db.one('SELECT value FROM public.settings WHERE key = $1', [key]);
  if (row) return row.value;
  const seeded = seedDefault(cfg, key);
  if (seeded !== undefined) await setSetting(db, key, seeded);
  return seeded;
}

export async function setSetting(db, key, value) {
  await db.query(
    'INSERT INTO public.settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)]);
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

export async function getPacks(db, cfg) {
  const { tokensPerUsd } = await getSetting(db, cfg, 'token_config');
  const packs = await getSetting(db, cfg, 'packs');
  return packs.map((p) => ({ ...p, tokens: Math.round(p.usd * tokensPerUsd) }));
}

export async function getPack(db, cfg, packId) {
  const packs = await getPacks(db, cfg);
  return packs.find((p) => p.id === packId) ?? null;
}

export async function getCard(db, cfg) {
  return getSetting(db, cfg, 'card');
}

/** Per-model multiplier table — server-side only; the client only ever displays it. */
export async function getMultiplier(db, cfg, model) {
  const models = await getSetting(db, cfg, 'models');
  const hit = models.find((m) => m.model === model);
  if (hit) return Number(hit.multiplier);
  const tokenConfig = await getSetting(db, cfg, 'token_config');
  return Number(tokenConfig.defaultMultiplier ?? 1);
}

/** Raw models-table entry for a model (or null) — carries `enabled` (admin toggle). */
export async function getModelEntry(db, cfg, model) {
  const models = await getSetting(db, cfg, 'models');
  return models.find((m) => m.model === model) ?? null;
}

export async function getModels(db, cfg) {
  return getSetting(db, cfg, 'models');
}
