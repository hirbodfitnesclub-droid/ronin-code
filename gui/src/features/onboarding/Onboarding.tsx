import { useState } from 'react';
import { api, type Status, type Theme } from '../../lib/api';
import { modelById } from '../../lib/models';
import { useLang, type Lang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';
import ThemeSegmented from '../../components/ui/ThemeSegmented';
import ModelMultiSelect from '../settings/ModelMultiSelect';

interface Props {
  status: Status | null;
  onLanguage: (lang: Lang) => void;
  onDone: () => void;
}

/* Sensible starter set spanning families and price points. */
const DEFAULT_MODELS = [
  'deepseek-v4.1-flash',
  'mimo-v2.6-flash',
  'gpt-6-luna',
  'gpt-5.6-terra',
  'claude-sonnet-5',
  'gemini-3.8-flash',
  'grok-4.7',
  'qwen3.8-flash',
];

/** First-run flow (post-login): step 1 pick models, step 2 essentials
    (theme + language). BYOK keys are NOT collected here — they live in
    Settings. Finish persists everything in one saveSettings call. */
export default function Onboarding({ status, onLanguage, onDone }: Props) {
  const { t } = useLang();
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState<Lang>(status?.language ?? 'en');
  const [selected, setSelected] = useState<string[]>(() => {
    const fromStatus = (status?.enabledModels ?? []).filter((id_) => modelById(id_));
    return fromStatus.length > 0 ? fromStatus : DEFAULT_MODELS.filter((id_) => modelById(id_));
  });
  const [theme, setTheme] = useState<Theme>(status?.theme ?? 'dark');
  const [saving, setSaving] = useState(false);

  const pickLang = (l: Lang) => {
    setLang(l);
    onLanguage(l);
  };

  const pickTheme = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
  };

  const finish = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        enabledModels: selected,
        activeModelId: selected[0],
        theme,
        language: lang,
        onboarded: true,
      });
    } catch {
      /* the main UI surfaces errors after onboarding; do not trap the user here */
    } finally {
      setSaving(false);
      onDone();
    }
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true">
      <div className="onboarding-card onboarding-card--wide">
        <div className="onboarding-dots" aria-hidden="true">
          {[0, 1].map((i) => (
            <span
              key={i}
              className={`onboarding-dot ${i === step ? 'onboarding-dot--active' : ''} ${i < step ? 'onboarding-dot--done' : ''}`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="onboarding-step">
            <div className="onboarding-logo">
              <Logo />
            </div>
            <h1>{t('onboarding.modelsTitle')}</h1>
            <p className="onboarding-sub">{t('onboarding.modelsSub')}</p>
            <ModelMultiSelect value={selected} onChange={setSelected} />
            <p className="field-hint onboarding-note">{t('settings.models.changeNote')}</p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setStep(1)}
                disabled={selected.length === 0}
              >
                {t('onboarding.continue')}
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-step">
            <h1>{t('onboarding.essentialsTitle')}</h1>
            <p className="onboarding-sub">{t('onboarding.essentialsSub')}</p>

            <p className="field-label onboarding-lang-label">{t('onboarding.theme')}</p>
            <div className="onboarding-theme-row">
              <ThemeSegmented value={theme} onChange={pickTheme} labelKey="onboarding.theme" />
            </div>

            <p className="field-label onboarding-lang-label">{t('onboarding.chooseLang')}</p>
            <div className="lang-cards">
              <button
                type="button"
                className={`lang-card ${lang === 'en' ? 'lang-card--active' : ''}`}
                onClick={() => pickLang('en')}
              >
                <span className="lang-card-name">English</span>
                <span className="lang-card-sample">Build something beautiful</span>
              </button>
              <button
                type="button"
                className={`lang-card ${lang === 'fa' ? 'lang-card--active' : ''}`}
                onClick={() => pickLang('fa')}
                lang="fa"
              >
                <span className="lang-card-name">فارسی</span>
                <span className="lang-card-sample">یه چیز زیبا بساز</span>
              </button>
            </div>

            <p className="field-hint onboarding-note">{t('onboarding.keysNote')}</p>

            <div className="onboarding-actions onboarding-actions--split">
              <button type="button" className="btn btn--ghost" onClick={() => setStep(0)}>
                {t('onboarding.back')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void finish()} disabled={saving}>
                {t('onboarding.finish')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
