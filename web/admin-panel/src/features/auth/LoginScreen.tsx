import { useState } from 'react';
import { api, setCsrf, type Session } from '../../lib/api';
import { ErrorBox, Field, errText } from '../../components/ui/primitives';

export default function LoginScreen({ onLogin }: { onLogin: (s: Session) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function sendCode() {
    setBusy(true);
    setError('');
    try {
      await api.requestOtp(phone.trim());
      setSent(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError('');
    try {
      const s = await api.verifyOtp(phone.trim(), code.trim());
      setCsrf(s.csrfToken);
      onLogin(s);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div className="brand-mark" style={{ margin: '0 auto 12px' }} />
          <h1>پنل مدیریت رونین کد</h1>
          <p className="dim small" style={{ marginTop: 6 }}>
            ورود با شماره موبایل و کد یک‌بارمصرف پیامکی
          </p>
        </div>
        <div className="form-grid">
          <ErrorBox message={error} />
          <Field label="شماره موبایل">
            <input
              data-testid="login-phone"
              className="input ltr"
              dir="ltr"
              inputMode="tel"
              placeholder="09123456789"
              value={phone}
              disabled={sent}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          {!sent ? (
            <button data-testid="login-send" type="button" className="btn btn-primary" disabled={busy || !phone.trim()} onClick={sendCode}>
              {busy ? 'در حال ارسال…' : 'ارسال کد ورود'}
            </button>
          ) : (
            <>
              <Field label="کد ۶ رقمی پیامک‌شده">
                <input
                  data-testid="login-code"
                  className="input ltr"
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <button data-testid="login-verify" type="button" className="btn btn-primary" disabled={busy || code.trim().length < 6} onClick={verify}>
                {busy ? 'در حال بررسی…' : 'ورود به پنل'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setSent(false);
                  setCode('');
                }}
              >
                تغییر شماره موبایل
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
