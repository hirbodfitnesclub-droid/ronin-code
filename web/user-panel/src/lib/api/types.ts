/* Ronin Code user panel — API contract types.
   Balance is NEVER computed client-side: it always comes from
   /api/me, /api/account-status or /api/credits responses. */

export interface User {
  id: string;
  phone: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
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

export interface MeResult {
  user: User;
  balanceTokens: number;
  spendableTokens: number;
  isAdminPhone: boolean;
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
}

export interface Pack {
  id: string;
  title: string;
  usd: number;
  priceRials: number;
  validityDays: number;
  badge: string | null;
  tokens: number;
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
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  active: boolean;
}

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
}

/** The one interface every screen consumes. */
export interface PanelApi {
  getSession(): Session | null;
  requestOtp(phone: string): Promise<{ ok: boolean }>;
  verifyOtp(phone: string, code: string, deviceName: string): Promise<OtpVerifyResult>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  me(): Promise<MeResult>;
  accountStatus(): Promise<AccountStatus>;
  packs(): Promise<PacksResult>;
  credits(): Promise<CreditsResult>;
  devices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<void>;
  listClaims(): Promise<Claim[]>;
  createClaim(packId: string, receiptFile: File): Promise<Claim>;
  usageSummary(): Promise<UsageSummary>;
}
