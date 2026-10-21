import { useState } from 'react';
import { api, type Provider, type Status } from '../api';
import { useLang, type Lang } from '../i18n';
import Logo from './Logo';

interface Props {
  providers: Provider[];
  status: Status | null;
  onLanguage: (lang: Lang) => void;
  onDone: () => void;
  onCreateStarter: () => void;
  onOpenProject: () => void;
}

/** First-run flow: welcome + language → provider key (skippable) → ready. */
export default function Onboarding({ providers, status, onLanguage, onDone, onCreateStarter, onOpenProject }: Props) {
  const { t } = useLang();
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState<Lang>(status?.language ?? 'en');
  const [provider, setProvider] = useState(status?.provider ?? 'anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = providers.find((p) => p.id === provider);

  const pickLang = (l: Lang) => {
    setLang(l);
    onLanguage(l);
  };

  const finish = async (withKey: boolean) => {
    setSaving(true);
    try {
      await api.saveSettings({
        language: lang,
        onboarded: true,
        provider,
        ...(withKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(withKey && model.trim() ? { model: model.trim() } : {}),
        ...(withKey && provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
      });
      setStep(2);
    } catch {
      /* stay on the step; the main UI surfaces errors after onboarding */
      setStep(2);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (apiKey.trim()) {
        await api.saveSettings({
          provider,
          apiKey: apiKey.trim(),
          ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        });
      }
      setTestResult(await api.testSettings(provider, provider === 'custom' ? baseUrl.trim() : undefined));
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : t('settings.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true">
      <div className="onboarding-card">
        <div className="onboarding-dots" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className={`onboarding-dot ${i === step ? 'onboarding-dot--active' : ''} ${i < step ? 'onboarding-dot--done' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <div className="onboarding-step">
            <div className="onboarding-logo"><Logo /></div>
            <h1>{t('onboarding.welcomeTitle')}</h1>
            <p className="onboarding-sub">{t('onboarding.welcomeSub')}</p>
            <p className="field-label onboarding-lang-label">{t('onboarding.chooseLang')}</p>
            <div className="lang-cards">
              <button type="button" className={`lang-card ${lang === 'en' ? 'lang-card--active' : ''}`} onClick={() => pickLang('en')}>
                <span className="lang-card-name">English</span>
                <span className="lang-card-sample">Build something beautiful</span>
              </button>
              <button type="button" className={`lang-card ${lang === 'fa' ? 'lang-card--active' : ''}`} onClick={() => pickLang('fa')} lang="fa">
                <span className="lang-card-name">فارسی</span>
                <span className="lang-card-sample">یه چیز زیبا بساز</span>
              </button>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="btn btn--primary" onClick={() => setStep(1)}>
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-step">
            <h1>{t('onboarding.providerTitle')}</h1>
            <p className="onboarding-sub">{t('onboarding.providerSub')}</p>
            <label className="field">
              <span className="field-label">{t('settings.provider')}</span>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  const p = providers.find((x) => x.id === e.target.value);
                  setModel(p?.defaultModel ?? '');
                  setBaseUrl(p?.baseUrl ?? '');
                  setTestResult(null);
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
            {provider === 'custom' && (
              <label className="field">
                <span className="field-label">{t('settings.endpointUrl')}</span>
                <input type="url" dir="ltr" autoComplete="off" spellCheck={false} value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-endpoint.example/v1" />
              </label>
            )}
            <label className="field">
              <span className="field-label">{t('settings.apiKey')}</span>
              <input type="password" dir="ltr" autoComplete="off" spellCheck={false} value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selected?.hasKey ? t('settings.keepKey', { masked: selected.maskedKey || '••••' }) : t('settings.apiKeyPlaceholder')} />
              <span className="field-hint">{t('settings.keysHint')}</span>
            </label>
            <label className="field">
              <span className="field-label">{t('settings.model')}</span>
              <input type="text" dir="ltr" autoComplete="off" spellCheck={false} value={model}
                onChange={(e) => setModel(e.target.value)} placeholder={selected?.defaultModel ?? t('settings.modelPlaceholder')} />
            </label>
            {testResult && (
              <p className={`test-result ${testResult.ok ? 'test-result--ok' : 'test-result--bad'}`}>{testResult.message}</p>
            )}
            <div className="onboarding-actions onboarding-actions--split">
              <button type="button" className="btn btn--ghost" onClick={() => setStep(0)}>{t('onboarding.back')}</button>
              <span className="onboarding-actions-right">
                <button type="button" className="btn btn--ghost" onClick={test} disabled={testing || saving}>
                  {testing ? t('settings.testing') : t('settings.test')}
                </button>
                <button type="button" className="btn btn--primary" onClick={() => void finish(true)} disabled={saving}>
                  {t('onboarding.continue')}
                </button>
              </span>
            </div>
            <button type="button" className="link-btn" onClick={() => void finish(false)} disabled={saving}>
              {t('onboarding.skip')}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <div className="onboarding-logo"><Logo /></div>
            <h1>{t('onboarding.doneTitle')}</h1>
            <p className="onboarding-sub">{t('onboarding.doneSub')}</p>
            <div className="onboarding-actions onboarding-actions--stack">
              <button type="button" className="btn btn--primary" onClick={() => { onCreateStarter(); onDone(); }}>
                {t('app.createStarter')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => { onOpenProject(); onDone(); }}>
                {t('app.openProject')}
              </button>
              <button type="button" className="link-btn" onClick={onDone}>
                {t('onboarding.startBuilding')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
