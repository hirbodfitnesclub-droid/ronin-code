import React, { createContext, useContext, useMemo } from 'react';
import { en, type StringKey } from './en';
import { fa } from './fa';
import { formatNumber, formatUsd, interpolate } from '../format';

/* Ronin Code — bilingual EN/FA i18n.
   Every user-facing string in the GUI lives in the en/fa dictionaries.
   Technical content (code, paths, model ids, URLs, user/model text) is
   never translated. */

export type Lang = 'en' | 'fa';
export type { StringKey };

const STRINGS: Record<Lang, Record<StringKey, string>> = { en, fa };

/** Host error codes → dictionary keys (host messages stay English as fallback). */
export const ERROR_CODE_KEYS: Record<string, StringKey> = {
  no_project: 'errors.no_project',
  prompt_required: 'errors.prompt_required',
  turn_running: 'errors.turn_running',
  budget_exceeded: 'errors.budget_exceeded',
  no_snapshot: 'errors.no_snapshot',
  not_found: 'errors.not_found',
};

export interface LangCtx {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  fmtNum: (n: number) => string;
  fmtUsd: (n: number) => string;
}

const Ctx = createContext<LangCtx>({
  lang: 'en',
  dir: 'ltr',
  t: (k) => en[k],
  fmtNum: (n) => String(n),
  fmtUsd: (n) => `$${n}`,
});

export function makeLangCtx(lang: Lang): LangCtx {
  const locale = lang === 'fa' ? 'fa-IR' : 'en-US';
  return {
    lang,
    dir: lang === 'fa' ? 'rtl' : 'ltr',
    t: (key, vars) => interpolate(STRINGS[lang][key] ?? en[key] ?? key, vars),
    fmtNum: (n) => formatNumber(n, locale),
    fmtUsd: (n) => formatUsd(n, locale),
  };
}

export function LanguageProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  const value = useMemo(() => makeLangCtx(lang), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
