import { Card } from '../../components/ui';
import { useLang } from '../../lib/i18n';

/* Stub — the full screen is built by a later builder on this foundation. */
export function DevicesScreen() {
  const { t } = useLang();
  return (
    <div>
      <Card>
        <h1 className="page-title">{t('devices.title')}</h1>
        <p className="page-sub">{t('app.tagline')}</p>
      </Card>
    </div>
  );
}
