import { useLang } from '../../lib/i18n';

/** Crimson double-chevron + wordmark. */
export function Logo() {
  const { lang } = useLang();
  return (
    <span className="logo">
      <span className="logo-mark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M5 4l7 8-7 8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <path
            d="M12 4l7 8-7 8"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.55"
          />
        </svg>
      </span>
      {lang === 'fa' ? 'رونین کد' : 'Ronin Code'}
    </span>
  );
}
