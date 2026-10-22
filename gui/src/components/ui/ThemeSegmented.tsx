import type { Theme } from '../../lib/api';
import { useLang } from '../../lib/i18n';

/* Ronin Code — Dark/Light segmented control (onboarding + settings). */

interface Props {
  value: Theme;
  onChange: (theme: Theme) => void;
  labelKey?: 'onboarding.theme' | 'settings.theme';
}

export default function ThemeSegmented({ value, onChange, labelKey = 'settings.theme' }: Props) {
  const { t } = useLang();
  const darkLabel = labelKey === 'onboarding.theme' ? t('onboarding.themeDark') : t('settings.themeDark');
  const lightLabel = labelKey === 'onboarding.theme' ? t('onboarding.themeLight') : t('settings.themeLight');
  return (
    <div className="segmented" role="group" aria-label={t(labelKey)}>
      <button
        type="button"
        className={`segmented-btn ${value === 'dark' ? 'segmented-btn--on' : ''}`}
        onClick={() => onChange('dark')}
        aria-pressed={value === 'dark'}
      >
        {darkLabel}
      </button>
      <button
        type="button"
        className={`segmented-btn ${value === 'light' ? 'segmented-btn--on' : ''}`}
        onClick={() => onChange('light')}
        aria-pressed={value === 'light'}
      >
        {lightLabel}
      </button>
    </div>
  );
}
