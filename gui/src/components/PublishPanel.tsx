import { useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';

interface Props {
  open: boolean;
  projectName: string;
  onClose: () => void;
}

/** One-click publish (local form): zip download + dist/ export + guidance. */
export default function PublishPanel({ open, projectName, onClose }: Props) {
  const { t } = useLang();
  const [busy, setBusy] = useState('');
  const [doneMsg, setDoneMsg] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  const downloadZip = async () => {
    setBusy('zip');
    setError('');
    try {
      const blob = await api.exportZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName || 'ronin-project'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknown'));
    } finally {
      setBusy('');
    }
  };

  const exportDist = async () => {
    setBusy('dist');
    setError('');
    try {
      const res = await api.exportDist();
      setDoneMsg(t('publish.distDone', { count: res.files }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknown'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('publish.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('publish.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>×</button>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
          <button type="button" className="btn btn--primary" onClick={() => void downloadZip()} disabled={busy !== ''}>
            {t('publish.zip')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void exportDist()} disabled={busy !== ''}>
            {t('publish.dist')}
          </button>
        </div>
        {doneMsg && <p className="test-result test-result--ok">{doneMsg}</p>}
        {error && <p className="test-result test-result--bad">{error}</p>}
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
