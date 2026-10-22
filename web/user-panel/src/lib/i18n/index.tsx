import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { en, type StringKey } from './en';
import { fa } from './fa';
import { formatNumber, formatToman, interpolate } from '../format';

/* Ronin Code user panel — bilingual EN/FA i18n (mirrors gui patterns).
   FA is the default; the choice persists in localStorage 'ronin.panel.lang'
   and drives document.lang / document.dir. */

export type Lang = 'en' | 'fa';
export type { StringKey };

const STORAGE_KEY = 'ronin.panel.lang';
const STRINGS: Record<Lang, Record<StringKey, string>> = { en, fa };

/** Server error codes → dictionary keys. */
export const ERROR_CODE_KEYS: Record<string, StringKey> = {
  invalid_phone: 'errors.invalid_phone',
  otp_cooldown: 'errors.otp_cooldown',
  otp_daily_limit: 'errors.otp_daily_limit',
  otp_ip_limit: 'errors.otp_ip_limit',
  otp_not_found: 'errors.otp_not_found',
  otp_expired: 'errors.otp_expired',
  otp_wrong: 'errors.otp_wrong',
  account_disabled: 'errors.account_disabled',
  too_many_pending: 'errors.too_many_pending',
  invalid_receipt_type: 'errors.invalid_receipt_type',
  receipt_required: 'errors.receipt_required',
  receipt_too_large: 'errors.receipt_too_large',
  not_found: 'errors.not_found',
  internal: 'errors.internal',
  handoff_rate_limited: 'errors.handoff_rate_limited',
  handoff_failed: 'errors.handoff_failed',
};

export interface LangCtx {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (l: Lang) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  fmtNum: (n: number) => string;
  fmtToman: (rials: number) => string;
  fmtDate: (iso: string) => string;
}

const Ctx = createContext<LangCtx>({
  lang: 'fa',
  dir: 'rtl',
  setLang: () => undefined,
  t: (k) => fa[k],
  fmtNum: (n) => String(n),
  fmtToman: (n) => String(n),
  fmtDate: (s) => s,
});

function initialLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'fa';
  } catch {
    return 'fa';
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.title = lang === 'fa' ? 'Ronin Code — پنل کاربری' : 'Ronin Code — User Panel';
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* storage unavailable — language simply will not persist */
    }
  }, [lang]);

  const value = useMemo<LangCtx>(() => {
    const locale = lang === 'fa' ? 'fa-IR' : 'en-US';
    return {
      lang,
      dir: lang === 'fa' ? 'rtl' : 'ltr',
      setLang: setLangState,
      t: (key, vars) => interpolate(STRINGS[lang][key] ?? en[key] ?? key, vars),
      /* Amounts always render as Latin digits with comma grouping, inside mono
         LTR islands — the board design. fa-IR's U+066C separator renders as a
         fractured floating glyph in Vazirmatn/mono contexts. Dates stay local. */
      fmtNum: (n) => formatNumber(n, 'en-US'),
      fmtToman: (rials) => formatToman(rials, 'en-US'),
      fmtDate: (iso) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale).format(d);
      },
    };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
