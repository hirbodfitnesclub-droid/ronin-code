import { useMemo, useState } from 'react';
import { api, type Provider, type Status, type Theme } from '../../lib/api';
import { modelById } from '../../lib/models';
import { useLang, type Lang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';
import ModelMultiSelect from '../settings/ModelMultiSelect';

interface Props {
  status: Status | null;
  providers: Provider[];
  onLanguage: (lang: Lang) => void;
  onDone: (openSettings: boolean) => void;
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

/** First-run flow (post-login) — RDX-02: ONE page, no wizard. Models
    (provider-grouped cards with toggles), Dark/Light theme cards with
    a live preview, language, and an honest start: the button explains
    itself when nothing is picked, and when the account has neither
    credit nor its own key it points at the two real doors (buy credit
    in the panel / add a key in Settings). BYOK keys are NOT collected
    here — they live in Settings. Finish persists in one saveSettings. */
export default function Onboarding({ status, providers, onLanguage, onDone }: Props) {
  const { t } = useLang();
  const [lang, setLang] = useState<Lang>(status?.language ?? 'en');
  const [selected, setSelected] = useState<string[]>(() => {
    const fromStatus = (status?.enabledModels ?? []).filter((id_) => modelById(id_));
    return fromStatus.length > 0 ? fromStatus : DEFAULT_MODELS.filter((id_) => modelById(id_));
  });
  const [theme, setTheme] = useState<Theme>(status?.theme ?? 'dark');
  const [saving, setSaving] = useState(false);

  const hasByok = useMemo(() => providers.some((p) => p.hasKey), [providers]);
  const spendable = status?.auth?.subscription?.spendableTokens ?? 0;
  const noAccess = !hasByok && spendable <= 0;
  const panelUrl = status?.panelUrl;

  const pickLang = (l: Lang) => {
    setLang(l);
    onLanguage(l);
  };

  const pickTheme = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
  };

  const finish = async (openSettings: boolean) => {
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
      onDone(openSettings);
    }
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true">
      <div className="onboarding-card onboarding-card--wide">
        <div className="onboarding-head">
          <div className="onboarding-logo">
            <Logo />
          </div>
          <h1>{t('onboarding.modelsTitle')}</h1>
          <p className="onboarding-sub">{t('onboarding.modelsSub')}</p>
        </div>

        <div className="onboarding-grid">
          <section className="onboarding-models">
            <ModelMultiSelect value={selected} onChange={setSelected} />
            <p className="field-hint onboarding-note">{t('settings.models.changeNote')}</p>
          </section>

          <div className="onboarding-side">
            <section>
              <p className="field-label onboarding-lang-label">{t('onboarding.theme')}</p>
              <div className="theme-cards">
                {(['dark', 'light'] as Theme[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`theme-card ${theme === id ? 'theme-card--selected' : ''}`}
                    onClick={() => pickTheme(id)}
                    aria-pressed={theme === id}
                  >
                    <span className={`theme-preview theme-preview--${id}`} aria-hidden="true">
                      <span className="theme-preview-side" />
                      <span className="theme-preview-main">
                        <span />
                        <span />
                        <span className="theme-preview-accent" />
                      </span>
                    </span>
                    <span className="theme-card-name">
                      {id === 'dark' ? t('onboarding.themeDark') : t('onboarding.themeLight')}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
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
            </section>

            <p className="field-hint onboarding-note">{t('onboarding.keysNote')}</p>

            {noAccess && (
              <div className="onboarding-noaccess" role="note">
                <p>{t('onboarding.noAccessNote')}</p>
                <div className="onboarding-noaccess-actions">
                  {panelUrl && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => window.open(panelUrl, '_blank', 'noopener')}
                    >
                      {t('picker.buyCredit')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void finish(true)}
                    disabled={saving || selected.length === 0}
                  >
                    {t('onboarding.addOwnKey')}
                  </button>
                </div>
              </div>
            )}

            <div className="onboarding-actions">
              <button
                type="button"
                className="btn btn--primary onboarding-start"
                onClick={() => void finish(false)}
                disabled={saving || selected.length === 0}
              >
                {t('onboarding.finish')}
              </button>
            </div>
            {selected.length === 0 && <p className="onboarding-required">{t('onboarding.modelsRequired')}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
