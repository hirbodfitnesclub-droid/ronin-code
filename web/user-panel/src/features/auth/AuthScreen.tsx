import { Card } from '../../components/ui';
import { useLang } from '../../lib/i18n';

/* Stub — the full screen is built by a later builder on this foundation. */
export function AuthScreen() {
  const { t, lang, setLang } = useLang();
  return (
    <div className="auth-wrap">
      <Card className="auth-card">
        <h1 className="page-title">{t('auth.title')}</h1>
        <p className="page-sub">{t('app.tagline')}</p>
        <button type="button" className="lang-toggle" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>
          {lang === 'fa' ? 'EN' : 'فارسی'}
        </button>
      </Card>
    </div>
  );
}
