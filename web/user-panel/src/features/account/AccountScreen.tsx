import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, Spinner } from '../../components/ui';
import { api, isApiError, type AccountStatus, type MeResult } from '../../lib/api';
import { ERROR_CODE_KEYS, useLang, type LangCtx } from '../../lib/i18n';
import './account.css';

function errorText(e: unknown, t: LangCtx['t']): string {
  if (isApiError(e)) {
    const key = ERROR_CODE_KEYS[e.code];
    if (key) return t(key);
    if (e.code === 'network') return t('errors.network');
  }
  return t('errors.unknown');
}

/** Same mechanism as Devices: api.logout() clears the stored session
    (client setSession(null) → clearSession()); this event lets the shell
    re-read the session and route back to login. */
function notifySessionChanged() {
  window.dispatchEvent(new CustomEvent('ronin:session-changed'));
}

function Chevron() {
  const { dir } = useLang();
  return (
    <svg
      className="account-chevron"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      style={dir === 'rtl' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/* Screen 7 — account: profile, language, plan status, sign out. */
export function AccountScreen() {
  const { t, fmtNum, fmtDate, lang, setLang } = useLang();
  const sessionUser = api.getSession()?.user ?? null;
  const [me, setMe] = useState<MeResult | null>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busyOut, setBusyOut] = useState(false);
  const [outErr, setOutErr] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const [meR, statusR] = await Promise.allSettled([api.me(), api.accountStatus()]);
        if (!alive) return;
        if (meR.status === 'rejected') throw meR.reason;
        setMe(meR.value);
        setStatus(statusR.status === 'fulfilled' ? statusR.value : null);
        setError(null);
      } catch (e) {
        if (alive) setError(errorText(e, t));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(load, [load]);

  const user = me?.user ?? sessionUser;
  const isActive = status?.isActive ?? user?.isActive ?? false;
  const spendable = status?.spendableTokens ?? me?.spendableTokens ?? null;
  const initial = (user?.name?.trim()[0] ?? user?.phone?.trim()[0] ?? 'R').toUpperCase();

  const signOut = async () => {
    setBusyOut(true);
    setOutErr(null);
    try {
      await api.logout();
    } catch (e) {
      if (api.getSession()) {
        setOutErr(errorText(e, t));
        setBusyOut(false);
        return;
      }
    }
    notifySessionChanged();
  };

  return (
    <div>
      <Card>
        <h1 className="page-title">{t('account.title')}</h1>
        {me === null && !error ? (
          <div className="account-center">
            <Spinner />
            <span>{t('common.loading')}</span>
          </div>
        ) : error ? (
          <div className="account-center">
            <span className="error-text">{error}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        ) : user ? (
          <div className="account-profile">
            <span className="account-avatar" aria-hidden="true">
              {initial}
            </span>
            <div>
              <div className="account-name">
                {user.name ?? user.phone}
                {isActive ? (
                  <Chip tone="green">{t('dashboard.active')}</Chip>
                ) : (
                  <Chip tone="accent">{t('dashboard.inactive')}</Chip>
                )}
              </div>
              <div className="account-sub">
                <span className="ltr-island">{user.phone}</span>
              </div>
              <div className="account-sub">{t('account.memberSince', { date: fmtDate(user.createdAt) })}</div>
            </div>
          </div>
        ) : null}
      </Card>

      {user && !error ? (
        <Card>
          <div className="account-rows">
            <div className="account-row">
              <span className="account-row-label">{t('account.phone')}</span>
              <span className="account-row-value ltr-island">{user.phone}</span>
            </div>
            <div className="account-row">
              <span className="account-row-label">
                {t('account.language')}
                <span className="account-row-hint">{t('account.languageHint')}</span>
              </span>
              <span className="account-segmented">
                <button type="button" className={lang === 'fa' ? 'is-active' : undefined} onClick={() => setLang('fa')}>
                  فارسی
                </button>
                <button type="button" className={lang === 'en' ? 'is-active' : undefined} onClick={() => setLang('en')}>
                  EN
                </button>
              </span>
            </div>
            <div className="account-row">
              <span className="account-row-label">{t('account.creditStatus')}</span>
              <span className="account-row-value">
                {spendable != null ? (
                  <>
                    <span className="ltr-island">{fmtNum(spendable)}</span> {t('common.tokens')}
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="account-row">
              <span className="account-row-label">{t('account.helpFaq')}</span>
              <Chevron />
            </div>
            <div className="account-row">
              <span className="account-row-label">{t('account.support')}</span>
              <Chevron />
            </div>
          </div>
        </Card>
      ) : null}

      <div className="account-logout-wrap">
        <button type="button" className="btn-logout" disabled={busyOut} onClick={signOut}>
          {t('account.signOutFull')}
        </button>
        {outErr ? (
          <div className="account-center">
            <span className="error-text">{outErr}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
