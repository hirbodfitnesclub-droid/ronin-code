import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import {
  formatHandoffCode,
  HANDOFF_CODE_LENGTH,
  handoffCodeComplete,
  normalizeHandoffCode,
  normalizeOtp,
  OTP_LENGTH,
  otpComplete,
} from '../../lib/codeInput';
import { useLang, type StringKey } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';
import SegmentedInput from './SegmentedInput';

/* Ronin Code — login gate (RDX-01). Four first-class states in the
   board-03 visual language, with ONLY the auth methods that exist:
   (1) start — primary browser sign-in CTA with the two fallbacks
       discoverable from the beginning;
   (2) waiting — the browser is open; the app polls the host session
       so a completed panel sign-in (deep link or not) lands here
       automatically; cancel + both fallbacks stay reachable;
   (3) manual return code — segmented RNC-XXXX-XXXX input with
       distinct invalid / expired / used errors and a get-new-code path;
   (4) in-app OTP — phone, 6-digit boxes, resend timer, edit number.
   No Google / email / password / guest path exists by design. */

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

type Phase = 'start' | 'waiting' | 'code' | 'otp-phone' | 'otp-code';

const RESEND_SECONDS = 60;

interface Props {
  onLoggedIn: () => void;
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>('start');
  const [opening, setOpening] = useState(false);

  const [codeBody, setCodeBody] = useState('');
  const [codeError, setCodeError] = useState<StringKey | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<StringKey | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  /* While waiting for the browser flow, poll the host session: the
     deep-link return (or a panel session completed any other way)
     flips authState.loggedIn and we hand over to the app. */
  useEffect(() => {
    if (phase !== 'waiting') return;
    let live = true;
    const timer = window.setInterval(() => {
      void api
        .authState()
        .then((s) => {
          if (live && s.loggedIn) onLoggedIn();
        })
        .catch(() => {
          /* host unreachable — the manual paths below still work */
        });
    }, 2500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [phase, onLoggedIn]);

  /* OTP resend countdown. */
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const openPanel = async () => {
    setOpening(true);
    try {
      const res = await api.openPanel();
      if (res?.url) window.open(res.url, '_blank', 'noopener');
      setPhase('waiting');
    } catch {
      /* browser did not open — go straight to the manual code path */
      setPhase('code');
    } finally {
      setOpening(false);
    }
  };

  const submitCode = async () => {
    if (!handoffCodeComplete(codeBody) || connecting) return;
    setCodeError(null);
    setConnecting(true);
    try {
      await api.exchangeCode(formatHandoffCode(codeBody));
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
      setResendIn(RESEND_SECONDS);
      setPhase('otp-code');
    } catch (err) {
      setOtpError(errorKey(err, OTP_ERROR_KEYS));
    } finally {
      setOtpBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (!otpComplete(otp) || otpBusy) return;
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

  const codeStale = codeError === 'auth.errorCodeExpired' || codeError === 'auth.errorCodeUsed';

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

        {phase === 'start' && (
          <>
            <button
              type="button"
              className="btn btn--primary login-browser-btn"
              onClick={() => void openPanel()}
              disabled={opening}
            >
              {t('auth.signInBrowser')}
            </button>
            <p className="login-hint">{t('auth.browserHint')}</p>
            <div className="auth-alt-links">
              <button type="button" className="auth-alt-link" onClick={() => setPhase('code')}>
                {t('auth.useManualCode')}
              </button>
              <button type="button" className="auth-alt-link" onClick={() => setPhase('otp-phone')}>
                {t('auth.useOtp')}
              </button>
            </div>
          </>
        )}

        {phase === 'waiting' && (
          <>
            <div className="login-wait" role="status">
              <div className="home-orb login-wait-orb" aria-hidden="true">
                <span />
              </div>
              <p className="login-wait-title">{t('auth.waitingTitle')}</p>
              <p className="login-hint">{t('auth.waitingSub')}</p>
            </div>
            <button type="button" className="btn btn--ghost login-connect-btn" onClick={() => setPhase('start')}>
              {t('auth.cancel')}
            </button>
            <div className="auth-alt-links">
              <button type="button" className="auth-alt-link" onClick={() => setPhase('code')}>
                {t('auth.useManualCode')}
              </button>
              <button type="button" className="auth-alt-link" onClick={() => setPhase('otp-phone')}>
                {t('auth.useOtp')}
              </button>
            </div>
          </>
        )}

        {phase === 'code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode();
            }}
          >
            <p className="login-hint login-hint--top">{t('auth.codeHint')}</p>
            <SegmentedInput
              value={codeBody}
              length={HANDOFF_CODE_LENGTH}
              groupAfter={4}
              prefix="RNC"
              accept={normalizeHandoffCode}
              onChange={(next) => {
                setCodeBody(next);
                setCodeError(null);
              }}
              ariaLabel={t('auth.codeLabel')}
              autoFocus
            />
            {codeError && (
              <p className="test-result test-result--bad" role="alert">
                {t(codeError)}
              </p>
            )}
            <button
              type="submit"
              className="btn btn--primary login-connect-btn"
              disabled={connecting || !handoffCodeComplete(codeBody)}
            >
              {connecting ? t('auth.connecting') : t('auth.verify')}
            </button>
            {codeStale ? (
              <button
                type="button"
                className="btn btn--ghost login-connect-btn"
                onClick={() => void openPanel()}
                disabled={opening}
              >
                {t('auth.getNewCode')}
              </button>
            ) : (
              <button type="button" className="auth-alt-link auth-alt-link--center" onClick={() => setPhase('start')}>
                {t('auth.back')}
              </button>
            )}
          </form>
        )}

        {phase === 'otp-phone' && (
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
                autoFocus
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
            <button type="submit" className="btn btn--primary login-connect-btn" disabled={otpBusy || !phone.trim()}>
              {otpBusy ? t('auth.sending') : t('auth.sendCode')}
            </button>
            <button type="button" className="auth-alt-link auth-alt-link--center" onClick={() => setPhase('start')}>
              {t('auth.back')}
            </button>
          </form>
        )}

        {phase === 'otp-code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verifyOtp();
            }}
          >
            <p className="login-hint login-hint--top">
              {t('auth.otpSentTo', { phone: phone.trim() })}
            </p>
            <SegmentedInput
              value={otp}
              length={OTP_LENGTH}
              accept={normalizeOtp}
              onChange={(next) => {
                setOtp(next);
                setOtpError(null);
              }}
              ariaLabel={t('auth.otpLabel')}
              autoFocus
            />
            {otpError && (
              <p className="test-result test-result--bad" role="alert">
                {t(otpError)}
              </p>
            )}
            <button
              type="submit"
              className="btn btn--primary login-connect-btn"
              disabled={otpBusy || !otpComplete(otp)}
            >
              {otpBusy ? t('auth.verifying') : t('auth.verify')}
            </button>
            <div className="auth-alt-links">
              <button
                type="button"
                className="auth-alt-link"
                onClick={() => void requestOtp()}
                disabled={otpBusy || resendIn > 0}
              >
                {resendIn > 0 ? t('auth.resendIn', { seconds: resendIn }) : t('auth.resend')}
              </button>
              <button
                type="button"
                className="auth-alt-link"
                onClick={() => {
                  setOtpError(null);
                  setPhase('otp-phone');
                }}
              >
                {t('auth.editNumber')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
