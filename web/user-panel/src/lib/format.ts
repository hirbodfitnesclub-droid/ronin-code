/* Ronin Code user panel — pure formatting helpers (mirrors gui). */

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

export function formatToman(rials: number, locale: string): string {
  return formatNumber(Math.round(rials / 10), locale);
}
