/* Ronin Code user panel — API contract types.
   Balance is NEVER computed client-side: it always comes from
   /api/me, /api/account-status or /api/credits responses. */

export interface User {
  id: string;
  phone: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
  onboarded: boolean;
  acquisitionSource: string | null;
  onboardingGoal: string | null;
}

/* First-login onboarding chips (single-select). Keys are what the server
   stores (POST /api/me/onboarding validates against the same lists). */
export const ACQUISITION_SOURCES = ['instagram', 'telegram', 'friend', 'google', 'youtube_aparat', 'other'] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];
export const ONBOARDING_GOALS = ['personal', 'freelance', 'business', 'learning', 'other'] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export interface OnboardingInput {
  name: string;
  acquisitionSource: AcquisitionSource;
  onboardingGoal?: OnboardingGoal | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  user: User;
}

export interface OtpVerifyResult {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSec: number;
  user: User;
  deviceId: string;
}

/* ── Phase 2 per-user provider keys (design §7) ──────────────────────────
   routingMode comes from /api/account-status (and is mirrored on /api/me and
   /api/credits in per-user mode). 'shared' = v1 ledger-metered path.
   Keys are NEVER transported to the panel: only a masked hint (last 4). */
export type RoutingMode = 'shared' | 'per_user';

export type ProviderKeyStatus =
  'active' | 'frozen' | 'pending_create' | 'converting' | 'needs_attention' | 'deleted' | 'none';

export interface ProviderKeySummary {
  status: ProviderKeyStatus;
  /** Cumulative allowance issued to the user's delegated key. */
  tokenLimitIssued: number;
  /** True when the cached provider balance is past its 60s TTL (§7.1). */
  balanceStale?: boolean;
  /** When the provider balance was last observed (ISO). */
  balanceObservedAt?: string | null;
  /** Masked hint only — last 4 chars, e.g. '9f3k'. Never a full key. */
  keyLast4?: string | null;
}

export interface MeResult {
  user: User;
  balanceTokens: number;
  spendableTokens: number;
  isAdminPhone: boolean;
  routingMode?: RoutingMode;
  providerKey?: ProviderKeySummary | null;
}

export interface CreditLot {
  id: string;
  tokensLeft: number;
  expiresAt: string | null;
}

export interface AccountStatus {
  userId: string;
  status: string;
  isActive: boolean;
  balanceTokens: number;
  spendableTokens: number;
  lots: CreditLot[];
  deviceAuthorized: boolean;
  activeDevices: number;
  serverTime: string;
  routingMode?: RoutingMode;
  providerKey?: ProviderKeySummary | null;
}

export interface Pack {
  id: string;
  title: string;
  priceRials: number;
  validityDays: number;
  badge: string | null;
  tokens: number;
}

/** Server-issued one-time connection code for the desktop app
    (POST /api/auth/handoff with the panel Bearer session). */
export interface HandoffResult {
  code: string;
  expiresInSec: number;
}

export interface ShopCard {
  number: string;
  holder: string;
  bank: string;
}

export interface PacksResult {
  packs: Pack[];
  card: ShopCard;
}

export type LedgerKind = 'purchase' | 'consume' | 'hold' | 'release' | 'adjust' | 'expire';

export interface LedgerRow {
  id: string;
  kind: LedgerKind;
  deltaTokens: number;
  amountTokens: number;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
  /** Not yet exposed by the live /api/credits ledger — optional. */
  model?: string;
  /** Not yet exposed by the live /api/credits ledger — optional. */
  multiplier?: number;
}

export interface Order {
  id: string;
  [key: string]: unknown;
}

export interface CreditsResult {
  balanceTokens: number;
  spendableTokens: number;
  ledger: LedgerRow[];
  orders: Order[];
  routingMode?: RoutingMode;
  providerKey?: ProviderKeySummary | null;
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  active: boolean;
}

/** Phase-2 issuance state joined onto orders (§7.2). 'needs_attention' is
    NOT an error for the user — the purchase is safe, provisioning is being
    finalised server-side. */
export type IssuanceState = 'pending' | 'confirmed' | 'needs_attention' | 'not_applicable';

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

/** A receipt claim, as returned by GET /api/orders (no form fields:
    no payerName / cardLast4 / reference — receipt photo only). */
export interface Claim {
  id: string;
  packId: string;
  packTitle: string;
  tokens: number;
  priceRials: number;
  status: ClaimStatus;
  rejectReason: string | null;
  adminNote: string | null;
  hasReceipt: boolean;
  createdAt: string;
  reviewedAt: string | null;
  /** Phase 2: provider-key issuance for an approved claim (§7.2). */
  issuanceState?: IssuanceState | null;
}

/** Raw order JSON from GET /api/orders — superset of Claim. */
export interface OrderRow {
  id: string;
  packId: string;
  packTitle: string;
  tokens: number;
  priceRials: number;
  receivedAmountRials: number | null;
  status: ClaimStatus;
  rejectReason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  hasReceipt: boolean;
  issuanceState?: IssuanceState | null;
}

export interface DayUsage {
  date: string;
  tokens: number;
}

export interface ModelUsage {
  model: string;
  tokens: number;
  multiplier?: number;
}

export interface UsageSummary {
  todayTokens: number;
  monthTokens: number;
  last7Days: DayUsage[];
  topModels: ModelUsage[];
  /** Per-user mode (§7.3): true when a day in range is built from a partial
      poll (provider logs capped at 30 rows) — figures are a lower bound. */
  hasPartialDays?: boolean;
  partialDates?: string[];
}

/** One provider-log row from GET /api/usage/recent (§7.2). The provider
    returns at most the 30 most recent requests — never full history. */
export interface RecentUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costTokens: number;
  fast: boolean;
  status: string;
  createdAt: string;
}

export interface RecentUsageResult {
  rows: RecentUsageRow[];
  totalRequests: number;
  /** Server echoes the window semantics; currently always 'recent_30'. */
  windowNote: string;
}

/** The one interface every screen consumes. */
export interface PanelApi {
  getSession(): Session | null;
  requestOtp(phone: string): Promise<{ ok: boolean }>;
  verifyOtp(phone: string, code: string, deviceName: string): Promise<OtpVerifyResult>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  me(): Promise<MeResult>;
  submitOnboarding(input: OnboardingInput): Promise<User>;
  accountStatus(): Promise<AccountStatus>;
  packs(): Promise<PacksResult>;
  credits(): Promise<CreditsResult>;
  devices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<void>;
  listClaims(): Promise<Claim[]>;
  createClaim(packId: string, receiptFile: File): Promise<Claim>;
  usageSummary(): Promise<UsageSummary>;
  /** Per-user mode only: provider-logs recent activity (§7.2).
      Returns null in shared mode (ledger history is the source there). */
  recentUsage(): Promise<RecentUsageResult | null>;
  issueHandoff(): Promise<HandoffResult>;
}
