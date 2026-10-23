import type {
  Claim,
  Device,
  LedgerRow,
  Pack,
  ProviderKeySummary,
  RecentUsageResult,
  ShopCard,
  UsageSummary,
  User,
} from './types';

/* Mock fixtures — ONE consistent identity echoing the design boards. */
export const MOCK_USER: User = {
  id: 'user-1',
  phone: '09123456789',
  name: 'علی محمدی',
  isActive: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  // Mock login exercises the first-login onboarding screen; submitting it
  // flips this to true for the rest of the session.
  onboarded: false,
  acquisitionSource: null,
  onboardingGoal: null,
};

export const MOCK_BALANCE = 1_250_000;

/* The real launch lineup (final Toman prices only — no $ anywhere). */
export const MOCK_PACKS: Pack[] = [
  {
    id: 'pack-20m',
    title: 'بسته ۲۰ میلیون',
    priceRials: 2_800_000,
    validityDays: 30,
    badge: null,
    tokens: 20_000_000,
  },
  {
    id: 'pack-50m',
    title: 'بسته ۵۰ میلیون',
    priceRials: 7_000_000,
    validityDays: 60,
    badge: 'popular',
    tokens: 50_000_000,
  },
  {
    id: 'pack-100m',
    title: 'بسته ۱۰۰ میلیون',
    priceRials: 14_000_000,
    validityDays: 90,
    badge: null,
    tokens: 100_000_000,
  },
  {
    id: 'pack-400m',
    title: 'بسته ۴۰۰ میلیون',
    priceRials: 56_000_000,
    validityDays: 180,
    badge: 'bestValue',
    tokens: 400_000_000,
  },
];

export const MOCK_CARD: ShopCard = { number: '6104 3378 9012 3456', holder: 'شرکت رونین کد', bank: 'بانک ملت' };

const now = Date.now();
const iso = (daysAgo: number, h = 12) => new Date(now - daysAgo * 86_400_000 + h * 3_600_000).toISOString();

export const MOCK_LEDGER: LedgerRow[] = [
  {
    id: 'led-1',
    kind: 'consume',
    deltaTokens: -8_420,
    amountTokens: 8_420,
    balanceAfter: MOCK_BALANCE,
    refType: 'request',
    refId: 'req-1',
    note: null,
    createdAt: iso(0, 2),
    model: 'deepseek-v4.1-flash',
    multiplier: 0.1,
  },
  {
    id: 'led-2',
    kind: 'consume',
    deltaTokens: -15_900,
    amountTokens: 15_900,
    balanceAfter: MOCK_BALANCE + 8_420,
    refType: 'request',
    refId: 'req-2',
    note: null,
    createdAt: iso(0, 5),
    model: 'claude-sonnet',
    multiplier: 1,
  },
  {
    id: 'led-3',
    kind: 'consume',
    deltaTokens: -42_000,
    amountTokens: 42_000,
    balanceAfter: MOCK_BALANCE + 24_320,
    refType: 'request',
    refId: 'req-3',
    note: null,
    createdAt: iso(1, 4),
    model: 'gpt-5-codex',
    multiplier: 0.5,
  },
  {
    id: 'led-4',
    kind: 'purchase',
    deltaTokens: 50_000_000,
    amountTokens: 50_000_000,
    balanceAfter: MOCK_BALANCE + 66_320,
    refType: 'order',
    refId: 'claim-2',
    note: null,
    createdAt: iso(6),
  },
  {
    id: 'led-5',
    kind: 'consume',
    deltaTokens: -96_130,
    amountTokens: 96_130,
    balanceAfter: MOCK_BALANCE - 433_680,
    refType: 'request',
    refId: 'req-4',
    note: null,
    createdAt: iso(9, 3),
    model: 'claude-sonnet',
    multiplier: 1,
  },
  {
    id: 'led-6',
    kind: 'hold',
    deltaTokens: -5_000,
    amountTokens: 5_000,
    balanceAfter: MOCK_BALANCE - 529_810,
    refType: 'request',
    refId: 'req-5',
    note: null,
    createdAt: iso(12),
  },
  {
    id: 'led-7',
    kind: 'release',
    deltaTokens: 5_000,
    amountTokens: 5_000,
    balanceAfter: MOCK_BALANCE - 524_810,
    refType: 'request',
    refId: 'req-5',
    note: null,
    createdAt: iso(12, 1),
  },
  {
    id: 'led-8',
    kind: 'expire',
    deltaTokens: -12_000,
    amountTokens: 12_000,
    balanceAfter: MOCK_BALANCE - 524_810,
    refType: 'lot',
    refId: 'lot-old',
    note: null,
    createdAt: iso(20),
  },
];

export const MOCK_CLAIMS: Claim[] = [
  {
    id: 'claim-1',
    packId: 'pack-50m',
    packTitle: 'بسته ۵۰ میلیون',
    tokens: 50_000_000,
    priceRials: 7_000_000,
    status: 'pending',
    rejectReason: null,
    adminNote: null,
    hasReceipt: true,
    createdAt: iso(0, 6),
    reviewedAt: null,
  },
  {
    id: 'claim-2',
    packId: 'pack-50m',
    packTitle: 'بسته ۵۰ میلیون',
    tokens: 50_000_000,
    priceRials: 7_000_000,
    status: 'approved',
    rejectReason: null,
    adminNote: null,
    hasReceipt: true,
    createdAt: iso(6),
    reviewedAt: iso(6, 3),
    issuanceState: 'confirmed',
  },
  {
    id: 'claim-3',
    packId: 'pack-20m',
    packTitle: 'بسته ۲۰ میلیون',
    tokens: 20_000_000,
    priceRials: 2_800_000,
    status: 'rejected',
    rejectReason: 'receipt_unreadable',
    adminNote: 'رسید خوانا نیست — لطفاً عکس واضح‌تری از رسید واریز آپلود کنید.',
    hasReceipt: true,
    createdAt: iso(11),
    reviewedAt: iso(11, 2),
  },
];

export const MOCK_DEVICES: Device[] = [
  { id: 'dev-1', name: 'Windows — Ronin App', createdAt: iso(40), lastSeenAt: iso(0, 0), active: true },
  { id: 'dev-2', name: 'MacBook Pro', createdAt: iso(25), lastSeenAt: iso(1, 8), active: true },
  { id: 'dev-3', name: 'iPhone 14', createdAt: iso(10), lastSeenAt: iso(3, 9), active: false },
];

/* Phase-2 per-user fixtures. FAKE key hint only — the mock never holds a real
   key; the panel only ever receives a last-4 hint (design §2.3/§7). The fake
   delegated key used in QA notes is sk-ronin-test…9f3k (never a real value). */
export const MOCK_PROVIDER_KEY: ProviderKeySummary = {
  status: 'active',
  tokenLimitIssued: 50_000_000,
  balanceStale: false,
  balanceObservedAt: new Date(now - 30_000).toISOString(),
  keyLast4: '9f3k',
};

export const MOCK_RECENT_USAGE: RecentUsageResult = {
  totalRequests: 47,
  windowNote: 'recent_30',
  rows: [
    {
      model: 'claude-sonnet',
      inputTokens: 4_120,
      outputTokens: 1_860,
      cachedTokens: 512,
      costTokens: 8_420,
      fast: false,
      status: 'success',
      createdAt: iso(0, 2),
    },
    {
      model: 'gpt-5-codex',
      inputTokens: 6_300,
      outputTokens: 2_410,
      cachedTokens: 0,
      costTokens: 15_900,
      fast: true,
      status: 'success',
      createdAt: iso(0, 5),
    },
    {
      model: 'deepseek-v4.1-flash',
      inputTokens: 9_800,
      outputTokens: 3_020,
      cachedTokens: 1_024,
      costTokens: 4_210,
      fast: false,
      status: 'success',
      createdAt: iso(1, 4),
    },
    {
      model: 'claude-sonnet',
      inputTokens: 12_450,
      outputTokens: 4_980,
      cachedTokens: 2_048,
      costTokens: 42_000,
      fast: false,
      status: 'success',
      createdAt: iso(1, 7),
    },
    {
      model: 'gpt-5-codex',
      inputTokens: 3_150,
      outputTokens: 940,
      cachedTokens: 0,
      costTokens: 6_730,
      fast: false,
      status: 'success',
      createdAt: iso(2, 3),
    },
  ],
};

/** Per-user summary (§7.3): same shape as MOCK_USAGE but rollup-sourced, with
    one partial day in range so the lower-bound footnote is exercised. */
export const MOCK_USAGE_PER_USER: UsageSummary = {
  todayTokens: 24_320,
  monthTokens: 621_450,
  last7Days: [6, 5, 4, 3, 2, 1]
    .map((d, i) => ({
      date: iso(d).slice(0, 10),
      tokens: [88_400, 132_700, 64_200, 151_900, 97_500, 62_430][i] ?? 0,
    }))
    .concat([{ date: iso(0).slice(0, 10), tokens: 24_320 }]),
  topModels: [
    { model: 'claude-sonnet', tokens: 312_400, multiplier: 1 },
    { model: 'gpt-5-codex', tokens: 198_750, multiplier: 0.5 },
    { model: 'deepseek-v4.1-flash', tokens: 110_300, multiplier: 0.1 },
  ],
  hasPartialDays: true,
  partialDates: [iso(2).slice(0, 10)],
};

export const MOCK_USAGE: UsageSummary = {
  todayTokens: 24_320,
  monthTokens: 621_450,
  last7Days: [6, 5, 4, 3, 2, 1]
    .map((d, i) => ({
      date: iso(d).slice(0, 10),
      tokens: [88_400, 132_700, 64_200, 151_900, 97_500, 62_430][i] ?? 0,
    }))
    .concat([{ date: iso(0).slice(0, 10), tokens: 24_320 }]),
  topModels: [
    { model: 'claude-sonnet', tokens: 312_400, multiplier: 1 },
    { model: 'gpt-5-codex', tokens: 198_750, multiplier: 0.5 },
    { model: 'deepseek-v4.1-flash', tokens: 110_300, multiplier: 0.1 },
  ],
};
