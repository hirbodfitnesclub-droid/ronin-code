import { useLang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';

/* Ronin Code — live preview panel: browser chrome + iframe of the
   project's /preview/ route, or the branded empty state. Collapses to
   a slim reopen tab. */

interface Props {
  open: boolean;
  project: string;
  previewKey: number;
  onRefresh: () => void;
  onSetOpen: (open: boolean) => void;
}

export default function PreviewPanel(p: Props) {
  const { t } = useLang();
  if (!p.open) {
    return (
      <button
        type="button"
        className="preview-reopen"
        onClick={() => p.onSetOpen(true)}
        aria-label={t('app.showPreview')}
        title={t('app.showPreview')}
      >
        ‹
      </button>
    );
  }
  return (
    <section className="preview-panel" aria-label="Live preview">
      <div className="preview-bar">
        <span className="preview-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="preview-url" dir="ltr">
          /preview/
        </span>
        <span className="preview-bar-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={p.onRefresh}
            aria-label={t('app.refreshPreview')}
            title={t('app.refreshPreview')}
          >
            ↻
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => p.onSetOpen(false)}
            aria-label={t('app.collapsePreview')}
            title={t('app.collapsePreview')}
          >
            ›
          </button>
        </span>
      </div>
      <div className="preview-frame-wrap">
        {p.project ? (
          <iframe
            key={p.previewKey}
            className="preview-frame"
            src={`/preview/?ronin_preview=${p.previewKey}`}
            title="Project preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="preview-empty">
            <div className="preview-empty-orb" aria-hidden="true">
              <span />
            </div>
            <Logo />
            <p className="preview-empty-title">{t('app.previewWillAppear')}</p>
            <p className="preview-empty-sub">{t('app.previewEmptySub')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
