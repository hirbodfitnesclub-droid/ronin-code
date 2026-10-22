/* Ronin Code — pure formatting helpers (unit-tested, no React, no DOM). */

/** Replace {name} placeholders with values: interpolate("Hi {n}", { n: 3 }). */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  let s = template;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function formatNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** USD with extra precision for sub-10-cent amounts (per-turn costs). */
export function formatUsd(n: number, locale: string): string {
  const digits = n !== 0 && Math.abs(n) < 0.1 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}
