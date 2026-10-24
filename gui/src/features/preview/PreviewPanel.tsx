import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';

/* Ronin Code — live preview panel (RDX-04): mini-browser chrome
   (back / forward / refresh + the /preview/ address) over the
   project's preview iframe, a skeleton while it loads, and the
   branded empty state when no project is open. Back/forward drive
   the iframe's own history (same-origin, so it really works).
   No fake window controls are drawn — the Tauri shell owns the frame. */

interface Props {
  open: boolean;
  project: string;
  previewKey: number;
  onRefresh: () => void;
  onSetOpen: (open: boolean) => void;
}

export default function PreviewPanel(p: Props) {
  const { t } = useLang();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  /* A new preview key (or a different project) means a fresh load. */
  useEffect(() => {
    setLoaded(false);
  }, [p.previewKey, p.project]);

  const historyGo = (delta: number) => {
    try {
      frameRef.current?.contentWindow?.history.go(delta);
    } catch {
      /* cross-origin safety — the preview is same-origin by design */
    }
  };

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
        <span className="preview-nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => historyGo(-1)}
            disabled={!p.project}
            aria-label={t('preview.back')}
            title={t('preview.back')}
          >
            ‹
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => historyGo(1)}
            disabled={!p.project}
            aria-label={t('preview.forward')}
            title={t('preview.forward')}
          >
            ›
          </button>
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
          <>
            {!loaded && (
              <div className="preview-skeleton" aria-hidden="true">
                <div className="preview-skeleton-bar" />
                <div className="preview-skeleton-hero" />
                <div className="preview-skeleton-lines">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <iframe
              ref={frameRef}
              key={p.previewKey}
              className="preview-frame"
              src={`/preview/?ronin_preview=${p.previewKey}`}
              title="Project preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={() => setLoaded(true)}
            />
          </>
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
