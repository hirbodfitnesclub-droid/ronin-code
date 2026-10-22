import { useState } from 'react';
import { Card, Logo, Spinner } from '../../components/ui';
import { api, isApiError } from '../../lib/api';
import {
  ACQUISITION_SOURCES,
  ONBOARDING_GOALS,
  type AcquisitionSource,
  type OnboardingGoal,
} from '../../lib/api/types';
import { useLang, type StringKey } from '../../lib/i18n';
import './onboarding.css';

/* First-login onboarding — ONE short screen (owner decision 2026-10-22).
   Shown after the first successful OTP verify while profile.onboarded is
   false; submitting saves name + acquisition source (+ optional goal) via
   POST /api/me/onboarding, which flips the flag and returns the user, so
   the refreshed session routes straight into the shell. */

const ERROR_KEYS: Record<string, StringKey> = {
  name_required: 'errors.name_required',
  invalid_source: 'errors.invalid_source',
  invalid_goal: 'errors.invalid_goal',
};

export function OnboardingScreen({ onSessionChanged }: { onSessionChanged?: () => void } = {}) {
  const { t, lang, setLang } = useLang();
  const session = api.getSession();
  const [name, setName] = useState(session?.user.name ?? '');
  const [source, setSource] = useState<AcquisitionSource | null>(null);
  const [goal, setGoal] = useState<OnboardingGoal | null>(null);
  const [error, setError] = useState<StringKey | null>(null);
  const [saving, setSaving] = useState(false);

  const canSubmit = name.trim().length >= 2 && source !== null && !saving;

  const submit = async () => {
    if (!canSubmit || !source) return;
    setSaving(true);
    setError(null);
    try {
      await api.submitOnboarding({
        name: name.trim(),
        acquisitionSource: source,
        onboardingGoal: goal,
      });
      onSessionChanged?.();
    } catch (e) {
      setError(isApiError(e) ? (ERROR_KEYS[e.code] ?? 'errors.unknown') : 'errors.network');
      setSaving(false);
    }
  };

  return (
    <div className="auth-wrap">
      <Card className="auth-card auth-panel ob-card">
        <button
          type="button"
          className="lang-toggle auth-lang"
          onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
        >
          {lang === 'fa' ? 'EN' : 'فارسی'}
        </button>
        <div className="auth-logo">
          <Logo />
        </div>
        <h1 className="page-title auth-center">{t('onboarding.title')}</h1>
        <p className="page-sub auth-center">{t('onboarding.subtitle')}</p>

        {error ? (
          <div className="auth-error" role="alert">
            {t(error)}
          </div>
        ) : null}

        <div className="field ob-field">
          <label htmlFor="ob-name">{t('onboarding.nameLabel')}</label>
          <input
            id="ob-name"
            type="text"
            value={name}
            maxLength={80}
            placeholder={t('onboarding.namePlaceholder')}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field ob-field">
          <label>{t('onboarding.sourceLabel')}</label>
          <div className="ob-options" role="radiogroup" aria-label={t('onboarding.sourceLabel')}>
            {ACQUISITION_SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={source === s}
                className={source === s ? 'ob-option is-selected' : 'ob-option'}
                onClick={() => setSource(s)}
              >
                {t(`onboarding.source.${s}` as StringKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="field ob-field">
          <label>
            {t('onboarding.goalLabel')}{' '}
            <span className="ob-optional">({t('onboarding.goalOptional')})</span>
          </label>
          <div className="ob-options" role="radiogroup" aria-label={t('onboarding.goalLabel')}>
            {ONBOARDING_GOALS.map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={goal === g}
                className={goal === g ? 'ob-option is-selected' : 'ob-option'}
                onClick={() => setGoal(goal === g ? null : g)}
              >
                {t(`onboarding.goal.${g}` as StringKey)}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="btn btn-primary btn-block ob-start" disabled={!canSubmit} onClick={submit}>
          {saving ? (
            <>
              <Spinner /> {t('onboarding.saving')}
            </>
          ) : (
            t('onboarding.start')
          )}
        </button>
      </Card>
    </div>
  );
}
