import { useEffect, useState } from 'react';
import { api, hasCap, type Session, type Settings } from '../../lib/api';
import { Card, ErrorBox, Field, OkBox, Spinner, errText } from '../../components/ui/primitives';
import { ModelsEditor, PacksEditor, StaffEditor } from './SettingsEditors';

export default function SettingsScreen({ session }: { session: Session }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const canPolicy = hasCap(session, 'policy_write');
  const isOwner = session.role === 'owner';

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((e) => setError(errText(e)));
  }, []);

  if (!settings && !error) return <Spinner />;
  if (!settings) return <ErrorBox message={error} />;

  return (
    <div data-testid="screen-settings">
      <div className="page-head">
        <h1>تنظیمات</h1>
      </div>
      <ErrorBox message={error} />
      <div className="section-gap">
        <Card title="وضعیت پیامک">
          <p className="dim">
            ارائه‌دهنده: <span className="ltr mono">{settings.smsProvider}</span> — قالب‌های پیامک:{' '}
            {settings.smsTemplatesConfigured ? 'پیکربندی شده‌اند' : 'پیکربندی نشده‌اند'}
          </p>
        </Card>
        <CardForm settings={settings} canWrite={canPolicy} />
        <PacksEditor initial={settings.packs} canWrite={canPolicy} />
        <ModelsEditor initial={settings.models} canWrite={canPolicy} />
        <TokenConfigForm settings={settings} canWrite={canPolicy} />
        {isOwner && settings.financeStaff ? <StaffEditor initial={settings.financeStaff} /> : null}
      </div>
    </div>
  );
}

function CardForm({ settings, canWrite }: { settings: Settings; canWrite: boolean }) {
  const [number, setNumber] = useState(settings.card.number);
  const [holder, setHolder] = useState(settings.card.holder);
  const [bank, setBank] = useState(settings.card.bank);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.saveCard({ number: number.trim(), holder: holder.trim(), bank: bank.trim() });
      setOk('کارت فروشگاه ذخیره شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="کارت فروشگاه (کارت‌به‌کارت)">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="form-grid">
        <div className="form-row">
          <Field label="شماره کارت">
            <input className="input ltr" dir="ltr" disabled={!canWrite} value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field label="نام صاحب کارت">
            <input className="input" disabled={!canWrite} value={holder} onChange={(e) => setHolder(e.target.value)} />
          </Field>
          <Field label="بانک">
            <input className="input" disabled={!canWrite} value={bank} onChange={(e) => setBank(e.target.value)} />
          </Field>
        </div>
        {canWrite ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            ذخیره کارت
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function TokenConfigForm({ settings, canWrite }: { settings: Settings; canWrite: boolean }) {
  const [tokensPerUsd, setTokensPerUsd] = useState(String(settings.tokenConfig.tokensPerUsd));
  const [defaultMultiplier, setDefaultMultiplier] = useState(String(settings.tokenConfig.defaultMultiplier));
  const [usdRialRate, setUsdRialRate] = useState(String(settings.tokenConfig.usdRialRate));
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.saveTokenConfig({
        tokensPerUsd: Number(tokensPerUsd),
        defaultMultiplier: Number(defaultMultiplier),
        usdRialRate: Number(usdRialRate),
      });
      setOk('پیکربندی توکن ذخیره شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="پیکربندی توکن و نرخ دلار">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="form-grid">
        <div className="form-row">
          <Field label="توکن به‌ازای هر دلار">
            <input className="input ltr" dir="ltr" inputMode="numeric" disabled={!canWrite} value={tokensPerUsd} onChange={(e) => setTokensPerUsd(e.target.value)} />
          </Field>
          <Field label="ضریب پیش‌فرض">
            <input className="input ltr" dir="ltr" inputMode="decimal" disabled={!canWrite} value={defaultMultiplier} onChange={(e) => setDefaultMultiplier(e.target.value)} />
          </Field>
          <Field label="نرخ دلار (ریال)">
            <input className="input ltr" dir="ltr" inputMode="numeric" disabled={!canWrite} value={usdRialRate} onChange={(e) => setUsdRialRate(e.target.value)} />
          </Field>
        </div>
        {canWrite ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            ذخیره پیکربندی
          </button>
        ) : null}
      </div>
    </Card>
  );
}
