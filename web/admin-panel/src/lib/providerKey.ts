// Phase 2 per-user provider keys — admin-side types + pure helpers.
// Design: docs/phase2-reseller-design.md §3.5, §7.4, §8.
// Keys are ALWAYS masked here: the API only ever returns a last-4 hint.
import { formatDateTime, formatTokens } from './format.ts';

/** Full-key pattern (provider-style secrets). Used by redaction + tests. */
export const FULL_KEY_PATTERN = /sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g;

/** Redact any full-key material embedded in free text (notes, actor strings,
    error text) before it reaches the DOM — component-boundary defence even
    if a server payload smuggles a full key into an unexpected field. */
export function redactKeyMaterial(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(FULL_KEY_PATTERN, (m) => `•••• ${m.slice(-4)}`);
}

export type ProviderKeyStatus =
  | 'pending_create'
  | 'active'
  | 'frozen'
  | 'needs_attention'
  | 'deleted';

export type ProviderIntentKind =
  | 'create'
  | 'topup'
  | 'reduce'
  | 'freeze'
  | 'unfreeze'
  | 'delete'
  | 'convert';

export type ProviderIntentState =
  | 'pending'
  | 'in_flight'
  | 'issued'
  | 'confirmed'
  | 'needs_attention'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export interface ProviderIntent {
  id: string;
  kind: ProviderIntentKind;
  source: string;
  state: ProviderIntentState;
  amountTokens: number | null;
  targetTokenLimit: number | null;
  orderId: string | null;
  actor: string | null;
  attemptCount: number;
  providerHttpStatus: number | null;
  providerErrorCode: string | null;
  /** Pre-dispatch snapshots for top-ups (§3.4) — the admin's evidence when
      deciding whether an ambiguous top-up landed. */
  balanceBefore: number | null;
  usedBefore: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ProviderKeyDetail {
  exists: boolean;
  status: ProviderKeyStatus | 'none';
  /** Masked hint only — last 4 chars. Never a full key, never a prefix. */
  keyLast4: string | null;
  tokenLimitIssued: number;
  tokensUsedObserved: number;
  balanceObserved: number | null;
  balanceObservedAt: number | null;
  balanceStale: boolean;
  convertedAt: number | null;
  convertedTokens: number | null;
  lastReconciledAt: number | null;
  openDriftFlags: number;
  openAttentionFlags: number;
  /** Top-up / issuance history from our DB (§7.4) — newest first. */
  intents: ProviderIntent[];
  attentionIntents: ProviderIntent[];
}

export type ResolveDecision = 'mark_applied' | 'retry_once' | 'create_replacement' | 'abandon';

export const PROVIDER_KEY_STATUS_FA: Record<string, string> = {
  active: 'فعال',
  frozen: 'فریزشده',
  pending_create: 'در حال ایجاد',
  needs_attention: 'نیازمند بررسی',
  deleted: 'حذف‌شده',
  none: 'بدون کلید',
};

export const PROVIDER_INTENT_KIND_FA: Record<string, string> = {
  create: 'ایجاد کلید',
  topup: 'شارژ (افزایش سقف)',
  reduce: 'کاهش سقف',
  freeze: 'فریز',
  unfreeze: 'رفع فریز',
  delete: 'حذف کلید',
  convert: 'تبدیل از نسخه ۱',
};

export const PROVIDER_INTENT_STATE_FA: Record<string, string> = {
  pending: 'در صف',
  in_flight: 'در حال انجام',
  issued: 'صادرشده',
  confirmed: 'تأییدشده',
  needs_attention: 'نیازمند بررسی',
  failed: 'ناموفق',
  cancelled: 'لغوشده',
  superseded: 'جایگزین‌شده',
};

/** Reserved risk-flag kinds introduced by Phase 2 (§2.5/§8.3). They render in
    the existing risk UI like every other kind — only the label is friendlier. */
export const RISK_KIND_FA: Record<string, string> = {
  provider_drift: 'انحراف ارائه‌دهنده (provider_drift)',
  provider_key_attention: 'کلید ارائه‌دهنده نیازمند بررسی (provider_key_attention)',
};

export function riskKindLabel(kind: string): string {
  return RISK_KIND_FA[kind] ?? kind;
}

export function isProviderRiskKind(kind: string): boolean {
  return kind === 'provider_drift' || kind === 'provider_key_attention';
}

/** '•••• 9f3k' — the only key representation the UI ever shows. */
export function maskedProviderKey(keyLast4: string | null | undefined): string {
  if (!keyLast4) return '—';
  const last4 = keyLast4.replace(/^…+/, '').slice(-4);
  return last4 ? `•••• ${last4}` : '—';
}

/** Remaining allowance as observed: issued − used (never negative). Display
    only — the provider balance is an upper bound (§8.2), not money truth. */
export function remainingObserved(detail: Pick<ProviderKeyDetail, 'tokenLimitIssued' | 'tokensUsedObserved'>): number {
  return Math.max(0, detail.tokenLimitIssued - detail.tokensUsedObserved);
}

export function hasInFlightIntent(intents: ProviderIntent[], kinds: ProviderIntentKind[]): boolean {
  return intents.some((i) => kinds.includes(i.kind) && (i.state === 'pending' || i.state === 'in_flight'));
}

export function canFreeze(detail: ProviderKeyDetail): boolean {
  return detail.exists && detail.status === 'active' && !hasInFlightIntent(detail.intents, ['freeze', 'unfreeze']);
}

export function canUnfreeze(detail: ProviderKeyDetail): boolean {
  return detail.exists && detail.status === 'frozen' && !hasInFlightIntent(detail.intents, ['freeze', 'unfreeze']);
}

/** Resolution actions the design exposes (§3.5). 'create_replacement' only
    makes sense for create/convert intents whose key never materialised. */
export function resolveDecisionsFor(intent: ProviderIntent): ResolveDecision[] {
  if (intent.state !== 'needs_attention') return [];
  if (intent.kind === 'create' || intent.kind === 'convert') {
    return ['create_replacement', 'abandon'];
  }
  if (intent.kind === 'topup') return ['mark_applied', 'retry_once', 'abandon'];
  return ['retry_once', 'abandon'];
}

export const RESOLVE_DECISION_FA: Record<ResolveDecision, string> = {
  mark_applied: 'اعمال‌شده علامت بزن',
  retry_once: 'یک بار دیگر تلاش کن',
  create_replacement: 'ایجاد کلید جایگزین',
  abandon: 'رها کردن (بایگانی)',
};

/* ── IDOR-facing load classification ──────────────────────────────────────
   404 = the legitimate "no key for this user" empty state. EVERYTHING else
   (403 for another user's data, 401, 5xx, network) is the standard error
   state — never a partial render, never a crash. */
export function classifyProviderKeyError(e: unknown): 'not_found' | 'error' {
  const err = e as { status?: number; code?: string } | null;
  return err?.status === 404 || err?.code === 'not_found' ? 'not_found' : 'error';
}

/* ── Risk flag display (existing risk UI, §8) ─────────────────────────────
   Every string the risk table renders for a flag is built here; the note is
   key-redacted at the boundary. */
export interface RiskFlagDisplay {
  label: string;
  note: string;
  isProvider: boolean;
  warn: boolean;
}

export function riskFlagDisplay(flag: { kind: string; note: string | null; status: string }): RiskFlagDisplay {
  const provider = isProviderRiskKind(flag.kind);
  return {
    label: riskKindLabel(flag.kind),
    note: redactKeyMaterial(flag.note) || '—',
    isProvider: provider,
    warn: provider && flag.status === 'open',
  };
}

/* ── Provider-key card view model ─────────────────────────────────────────
   EVERY display string of the dossier key section is produced here so the
   hard test battery can assert on the exact rendered content. The raw
   keyLast4 field is consumed ONLY by maskedProviderKey inside this builder;
   free-text fields (actor, source, error codes) are key-redacted. */
export interface ProviderKeyView {
  statusLabel: string;
  maskedKey: string;
  kv: { label: string; value: string }[];
  balanceStale: boolean;
  attention: {
    intentId: string;
    headline: string;
    evidence: string | null;
    decisions: ResolveDecision[];
  }[];
  intentRows: {
    id: string;
    kindLabel: string;
    source: string;
    amountText: string;
    stateLabel: string;
    state: ProviderIntentState;
    actor: string;
    dateText: string;
  }[];
  canFreeze: boolean;
  canUnfreeze: boolean;
}

export function buildProviderKeyView(detail: ProviderKeyDetail): ProviderKeyView {
  const kv: { label: string; value: string }[] = [
    { label: 'سقف صادرشده', value: `${formatTokens(detail.tokenLimitIssued)} توکن` },
    { label: 'مصرف مشاهده‌شده', value: `${formatTokens(detail.tokensUsedObserved)} توکن` },
    { label: 'باقی‌مانده مشاهده‌شده', value: `${formatTokens(remainingObserved(detail))} توکن` },
    {
      label: 'موجودی ارائه‌دهنده',
      value:
        `${formatTokens(detail.balanceObserved)} توکن` +
        (detail.balanceObservedAt ? ` — ${formatDateTime(detail.balanceObservedAt)}` : ''),
    },
  ];
  if (detail.convertedAt) {
    kv.push({
      label: 'تبدیل از نسخه ۱',
      value: `${formatTokens(detail.convertedTokens)} توکن — ${formatDateTime(detail.convertedAt)}`,
    });
  }
  kv.push({ label: 'پرچم انحراف باز', value: formatTokens(detail.openDriftFlags) });
  kv.push({ label: 'آخرین تطبیق', value: formatDateTime(detail.lastReconciledAt) });

  return {
    statusLabel: PROVIDER_KEY_STATUS_FA[detail.status] ?? detail.status,
    maskedKey: maskedProviderKey(detail.keyLast4),
    kv,
    balanceStale: detail.balanceStale,
    attention: detail.attentionIntents.map((intent) => ({
      intentId: intent.id,
      headline:
        `${PROVIDER_INTENT_KIND_FA[intent.kind] ?? intent.kind}` +
        (intent.amountTokens ? ` — ${formatTokens(intent.amountTokens)} توکن` : '') +
        ` · از ${formatDateTime(intent.createdAt)} · تلاش‌ها: ${formatTokens(intent.attemptCount)}` +
        (intent.providerErrorCode ? ` · کد ارائه‌دهنده: ${redactKeyMaterial(intent.providerErrorCode)}` : ''),
      evidence:
        intent.kind === 'topup' && (intent.balanceBefore !== null || intent.usedBefore !== null)
          ? `شواهد موجودی — قبل از ارسال: موجودی ${formatTokens(intent.balanceBefore)} · مصرف ${formatTokens(intent.usedBefore)} · موجودی فعلی مشاهده‌شده: ${formatTokens(detail.balanceObserved)}`
          : null,
      decisions: resolveDecisionsFor(intent),
    })),
    intentRows: detail.intents.map((i) => ({
      id: i.id,
      kindLabel: PROVIDER_INTENT_KIND_FA[i.kind] ?? i.kind,
      source: redactKeyMaterial(i.source),
      amountText: i.amountTokens !== null ? formatTokens(i.amountTokens) : '—',
      stateLabel: PROVIDER_INTENT_STATE_FA[i.state] ?? i.state,
      state: i.state,
      actor: redactKeyMaterial(i.actor) || '—',
      dateText: formatDateTime(i.createdAt),
    })),
    canFreeze: canFreeze(detail),
    canUnfreeze: canUnfreeze(detail),
  };
}
