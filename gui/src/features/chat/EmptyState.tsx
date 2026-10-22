import type { Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';

/* Ronin Code — chat empty state: hero, starter actions, example chips. */

interface Props {
  mode: Mode;
  onOpenStarters: () => void;
  onOpenProject: () => void;
  onSendExample: (text: string) => void;
}

export default function EmptyState(p: Props) {
  const { t } = useLang();
  const examples = [t('app.example1'), t('app.example2'), t('app.example3')];
  return (
    <div className="empty">
      <div className="empty-orb" aria-hidden="true">
        <span />
      </div>
      <h1>{t('app.whatBuild')}</h1>
      <p className="empty-sub">{t('app.tagline')}</p>
      {p.mode === 'preview' && <p className="preview-note preview-note--hero">{t('app.previewHeroNote')}</p>}
      <div className="empty-actions">
        <button type="button" className="btn btn--primary" onClick={() => void p.onOpenStarters()}>
          {t('app.createStarter')}
        </button>
        <button type="button" className="btn btn--ghost" onClick={p.onOpenProject}>
          {t('app.openProject')}
        </button>
      </div>
      <div className="chips">
        {examples.map((ex) => (
          <button key={ex} type="button" className="chip" onClick={() => void p.onSendExample(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
