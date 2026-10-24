import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { humanErrorText } from '../../lib/errors';
import { useLang } from '../../lib/i18n';

interface Props {
  open: boolean;
  projectName: string;
  onClose: () => void;
}

/* Ronin Code — publish (RDX-07): the existing real flow as an
   explicit state machine — ready → working (indeterminate, no fake
   percentages) → result (the real dist path + file count, or
   "download started") → failure with retry. The two outputs are the
   ones that exist: a project .zip download and a static dist/
   export, followed by the bring-your-own-host guidance. No custom
   domain / password / host-type options are offered — none exist. */

type Phase =
  | { kind: 'ready' }
  | { kind: 'working'; action: 'zip' | 'dist' }
  | { kind: 'done-zip' }
  | { kind: 'done-dist'; path: string; files: number }
  | { kind: 'error'; action: 'zip' | 'dist'; message: string };

export default function PublishPanel({ open, projectName, onClose }: Props) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });

  useEffect(() => {
    if (open) setPhase({ kind: 'ready' });
  }, [open ]);

  if (!open) return null;

  const downloadZip = async () => {
    setPhase({ kind: 'working', action: 'zip' });
    try {
      const blob = await api.exportZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName || 'ronin-project'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setPhase({ kind: 'done-zip' });
    } catch (err) {
      setPhase({ kind: 'error', action: 'zip', message: humanErrorText(err, t) });
    }
  };

  const exportDist = async () => {
    setPhase({ kind: 'working', action: 'dist' });
    try {
      const res = await api.exportDist();
      setPhase({ kind: 'done-dist', path: res.path, files: res.files });
    } catch (err) {
      setPhase({ kind: 'error', action: 'dist', message: humanErrorText(err, t) });
    }
  };

  const working = phase.kind === 'working';

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('publish.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t('publish.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </div>

        <div className="modal-actions" style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
          <button type="button" className="btn btn--primary" onClick={() => void downloadZip()} disabled={working}>
            {t('publish.zip')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void exportDist()} disabled={working}>
            {t('publish.dist')}
          </button>
        </div>

        {phase.kind === 'working' && (
          <div className="publish-status" role="status">
            <span className="publish-spinner" aria-hidden="true" />
            <span>{phase.action === 'zip' ? t('publish.preparingZip') : t('publish.exportingDist')}</span>
          </div>
        )}

        {phase.kind === 'done-zip' && (
          <p className="test-result test-result--ok" role="status">
            {t('publish.doneTitle')} — {t('publish.zipDone')}
          </p>
        )}

        {phase.kind === 'done-dist' && (
          <div className="publish-result" role="status">
            <p className="test-result test-result--ok">{t('publish.distDone', { count: phase.files })}</p>
            <p className="publish-result-path" dir="ltr">
              {phase.path}
            </p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="publish-status publish-status--error" role="alert">
            <span>
              {t('publish.failedTitle')} — {phase.message}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void (phase.action === 'zip' ? downloadZip() : exportDist())}
            >
              {t('chat.retry')}
            </button>
          </div>
        )}

        <div className="settings-section">
          <h3>{t('publish.nextTitle')}</h3>
          <ol className="publish-steps">
            <li>{t('publish.step1')}</li>
            <li>{t('publish.step2')}</li>
            <li>{t('publish.step3')}</li>
            <li>{t('publish.step4')}</li>
            <li>{t('publish.step5')}</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
