// Formatting helpers — Persian (fa-IR) numbers, Toman money, Jalali dates.
const nf = new Intl.NumberFormat('fa-IR');
const df = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'short', day: 'numeric' });
const dtf = new Intl.DateTimeFormat('fa-IR', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return nf.format(n);
}

/** Rials → Toman (rials/10), fa-IR grouped, with the تومان suffix. */
export function formatToman(rials: number | null | undefined): string {
  if (rials === null || rials === undefined || Number.isNaN(rials)) return '—';
  return `${nf.format(Math.round(rials / 10))} تومان`;
}

/** Bare rials amount, fa-IR grouped (no suffix). */
export function formatRials(rials: number | null | undefined): string {
  if (rials === null || rials === undefined || Number.isNaN(rials)) return '—';
  return nf.format(rials);
}

export function formatTokens(n: number | null | undefined): string {
  return formatNumber(n);
}

/** Epoch-ms (or ISO / yyyy-mm-dd string) → Jalali date. */
export function formatDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return df.format(d);
}

export function formatDateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf.format(d);
}

/** User-entered Toman string → rials (×10). Returns NaN on bad input. */
export function tomanToRials(toman: string): number {
  const cleaned = toman.replace(/[٬,\s]/g, '').replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 10) : NaN;
}

/** Rials → editable Toman string (plain digits, for inputs). */
export function rialsToTomanInput(rials: number | null | undefined): string {
  if (rials === null || rials === undefined) return '';
  return String(Math.round(rials / 10));
}

/** Today's date as yyyy-mm-dd (local), for date inputs / API params. */
export function todayIso(): string {
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
