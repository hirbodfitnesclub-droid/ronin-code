import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLang, type StringKey } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';

/* Ronin Code — login gate. Shown when the host reports an account is
   required and nobody is signed in. Three paths, one calm card:
   (1) continue in the browser panel, then paste the connection code;
   (2) the connection code itself; (3) in-app phone + OTP. */

const CODE_ERROR_KEYS: Record<string, StringKey> = {
  invalid_code: 'auth.errorInvalidCode',
  code_expired: 'auth.errorCodeExpired',
  code_used: 'auth.errorCodeUsed',
  handoff_rate_limited: 'auth.errorRateLimited',
};

const OTP_ERROR_KEYS: Record<string, StringKey> = {
  invalid_phone: 'auth.errorInvalidPhone',
  otp_wrong: 'auth.errorOtpWrong',
  otp_expired: 'auth.errorOtpExpired',
  otp_cooldown: 'auth.errorRateLimited',
  otp_daily_limit: 'auth.errorRateLimited',
  handoff_rate_limited: 'auth.errorRateLimited',
};

function errorKey(err: unknown, table: Record<string, StringKey>): StringKey {
  if (err instanceof ApiError && err.code && table[err.code]) return table[err.code];
  return 'auth.errorGeneric';
}

interface Props {
  onLoggedIn: () => void;
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<StringKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [opening, setOpening] = useState(false);

  const [phone, setPhone] = useState('');
  const [otpStep, setOtpStep] = useState<'phone' | 'code'>('phone');
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<StringKey | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);

  const openPanel = async () => {
    setOpening(true);
    try {
      const res = await api.openPanel();
      if (res?.url) window.open(res.url, '_blank', 'noopener');
    } catch {
      /* the hint below the button explains the manual path */
    } finally {
      setOpening(false);
    }
  };

  const submitCode = async () => {
    const value = code.trim().toUpperCase();
    if (!value || connecting) return;
    setCodeError(null);
    setConnecting(true);
    try {
      await api.exchangeCode(value);
      onLoggedIn();
    } catch (err) {
      setCodeError(errorKey(err, CODE_ERROR_KEYS));
    } finally {
      setConnecting(false);
    }
  };

  const requestOtp = async () => {
    if (!phone.trim() || otpBusy) return;
    setOtpError(null);
    setOtpBusy(true);
    try {
      await api.requestOtp(phone.trim());
      setOtp('');
      setOtpStep('code');
    } catch (err) {
      setOtpError(errorKey(err, OTP_ERROR_KEYS));
    } finally {
      setOtpBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.trim().length !== 6 || otpBusy) return;
    setOtpError(null);
    setOtpBusy(true);
    try {
      await api.verifyOtp(phone.trim(), otp.trim());
      onLoggedIn();
    } catch (err) {
      setOtpError(errorKey(err, OTP_ERROR_KEYS));
    } finally {
      setOtpBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <Logo />
          <span className="wordmark">
            Ronin <span className="wordmark-accent">Code</span>
          </span>
        </div>
        <h1>{t('auth.title')}</h1>
        <p className="login-sub">{t('auth.subtitle')}</p>

        <button type="button" className="btn btn--primary login-browser-btn" onClick={() => void openPanel()} disabled={opening}>
          {t('auth.continueBrowser')}
        </button>
        <p className="login-hint">{t('auth.browserHint')}</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode();
          }}
        >
          <label className="field">
            <span className="field-label">{t('auth.codeLabel')}</span>
            <input
              type="text"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="login-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={t('auth.codePlaceholder')}
            />
          </label>
          {codeError && (
            <p className="test-result test-result--bad" role="alert">
              {t(codeError)}
            </p>
          )}
          <button type="submit" className="btn btn--ghost login-connect-btn" disabled={connecting || !code.trim()}>
            {connecting ? t('auth.connecting') : t('auth.connect')}
          </button>
        </form>

        <div className="login-divider">
          <span>{t('auth.orDivider')}</span>
        </div>

        {otpStep === 'phone' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void requestOtp();
            }}
          >
            <label className="field">
              <span className="field-label">{t('auth.phoneLabel')}</span>
              <input
                type="tel"
                dir="ltr"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t('auth.phonePlaceholder')}
              />
            </label>
            {otpError && (
              <p className="test-result test-result--bad" role="alert">
                {t(otpError)}
              </p>
            )}
            <button type="submit" className="btn btn--ghost login-connect-btn" disabled={otpBusy || !phone.trim()}>
              {otpBusy ? t('auth.sending') : t('auth.sendCode')}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verifyOtp();
            }}
          >
            <label className="field">
              <span className="field-label">{t('auth.otpLabel')}</span>
              <input
                type="text"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="login-code-input"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
              />
            </label>
            {otpError && (
              <p className="test-result test-result--bad" role="alert">
                {t(otpError)}
              </p>
            )}
            <button type="submit" className="btn btn--ghost login-connect-btn" disabled={otpBusy || otp.length !== 6}>
              {otpBusy ? t('auth.verifying') : t('auth.verify')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
