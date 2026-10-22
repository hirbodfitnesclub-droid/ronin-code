import { useEffect, useRef, useState } from 'react';
import { Card, Logo, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useLang, type StringKey } from '../../lib/i18n';
import { OtpInput } from './OtpInput';
import {
  detectFromApp,
  deviceName,
  errorKeyFor,
  formatCountdown,
  formatPhoneDisplay,
  generateReturnCode,
  isValidPhone,
  maskPhone,
  normalizeDigits,
} from './helpers';
import './auth.css';

type Step = 'phone' | 'otp' | 'handoff';

const RESEND_SECONDS = 60;

export function AuthScreen({ onSessionChanged }: { onSessionChanged?: () => void } = {}) {
  const { t, lang, setLang } = useLang();
  const [fromApp] = useState<boolean>(detectFromApp);
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<StringKey | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendLeft, setResendLeft] = useState(0);
  const [returnCode, setReturnCode] = useState('');
  const [copied, setCopied] = useState(false);
  const reloadTimer = useRef<number | null>(null);

  useEffect(() => {
    if (step !== 'otp' || resendLeft <= 0) return;
    const id = window.setInterval(() => setResendLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [step, resendLeft]);

  useEffect(
    () => () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    },
    [],
  );

  const sendCode = async () => {
    if (!isValidPhone(phone)) {
      setError('errors.invalid_phone');
      return;
    }
    setError(null);
    setSending(true);
    try {
      await api.requestOtp(phone);
      setCode('');
      setStep('otp');
      setResendLeft(RESEND_SECONDS);
    } catch (e) {
      setError(errorKeyFor(e));
    } finally {
      setSending(false);
    }
  };

  const resend = async () => {
    if (resendLeft > 0 || sending) return;
    setError(null);
    setSending(true);
    try {
      await api.requestOtp(phone);
      setCode('');
      setResendLeft(RESEND_SECONDS);
    } catch (e) {
      setError(errorKeyFor(e));
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    if (code.length !== 6 || verifying) return;
    setError(null);
    setVerifying(true);
    try {
      await api.verifyOtp(phone, code, deviceName());
      if (fromApp) {
        // Do NOT notify the shell — the handoff screen replaces entering it.
        setReturnCode(generateReturnCode());
        setStep('handoff');
        return;
      }
      if (onSessionChanged) onSessionChanged();
      window.dispatchEvent(new CustomEvent('ronin:session-changed'));
      if (!onSessionChanged) {
        // The foundation App registers no session-changed listener and passes
        // no callback; the session is already persisted, so reload into the shell.
        reloadTimer.current = window.setTimeout(() => window.location.reload(), 400);
      }
    } catch (e) {
      setError(errorKeyFor(e));
    } finally {
      setVerifying(false);
    }
  };

  const copyReturnCode = async () => {
    try {
      await navigator.clipboard.writeText(returnCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the code stays visible for manual copying */
    }
  };

  const langToggle = (
    <button type="button" className="lang-toggle auth-lang" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>
      {lang === 'fa' ? 'EN' : 'فارسی'}
    </button>
  );

  const errorBox = error ? (
    <div className="auth-error" role="alert">
      {t(error)}
    </div>
  ) : null;

  if (step === 'handoff') {
    return (
      <div className="auth-wrap">
        <Card className="auth-card auth-panel">
          {langToggle}
          <div className="auth-success-icon" aria-hidden="true">
            ✓
          </div>
          <h1 className="page-title auth-center">{t('auth.returnCodeTitle')}</h1>
          <p className="auth-center auth-done-text">{t('auth.signedIn')}</p>
          <p className="page-sub auth-center">{t('auth.returnCodeHint')}</p>
          <div className="auth-return-label">{t('auth.returnCodeLabel')}</div>
          <div className="auth-return-row">
            <span className="auth-return-code ltr-island">{returnCode}</span>
            <button type="button" className="btn auth-copy-btn" onClick={copyReturnCode}>
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <Card className="auth-card auth-panel">
        {langToggle}
        <div className="auth-logo">
          <Logo />
        </div>
        {step === 'phone' ? (
          <>
            <h1 className="page-title auth-center">{t('auth.title')}</h1>
            <p className="page-sub auth-center">{t('auth.subtitle')}</p>
            {fromApp ? <div className="auth-banner">{t('auth.fromAppBanner')}</div> : null}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode();
              }}
            >
              <div className="field">
                <label htmlFor="auth-phone">{t('auth.phoneLabel')}</label>
                <input
                  id="auth-phone"
                  className="ltr-island auth-phone-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  dir="ltr"
                  placeholder="0912 345 6789"
                  value={formatPhoneDisplay(phone)}
                  onChange={(e) => setPhone(normalizeDigits(e.target.value).slice(0, 11))}
                />
                <p className="auth-hint">{t('auth.phoneHint')}</p>
              </div>
              {errorBox}
              <button type="submit" className="btn btn-primary btn-block auth-submit" disabled={sending}>
                {sending ? (
                  <>
                    <Spinner /> {t('auth.sending')}
                  </>
                ) : (
                  t('auth.sendCode')
                )}
              </button>
            </form>
            <p className="auth-hero-note">{t('auth.heroNote')}</p>
          </>
        ) : (
          <>
            <h1 className="page-title auth-center">{t('auth.otpTitle')}</h1>
            <p className="page-sub auth-center">{t('auth.otpSubtitle', { phone: maskPhone(phone) })}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <OtpInput value={code} onChange={setCode} disabled={verifying} label={t('auth.otpLabel')} />
              {errorBox}
              <button
                type="submit"
                className="btn btn-primary btn-block auth-submit"
                disabled={verifying || code.length !== 6}
              >
                {verifying ? (
                  <>
                    <Spinner /> {t('auth.verifying')}
                  </>
                ) : (
                  t('auth.verify')
                )}
              </button>
            </form>
            <div className="auth-otp-actions">
              {resendLeft > 0 ? (
                <span className="auth-resend-wait">
                  {t('auth.resendInClock', { time: formatCountdown(resendLeft) })}
                </span>
              ) : (
                <button type="button" className="auth-link" onClick={() => void resend()} disabled={sending}>
                  {t('auth.resend')}
                </button>
              )}
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setError(null);
                }}
              >
                {t('auth.changePhone')}
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
