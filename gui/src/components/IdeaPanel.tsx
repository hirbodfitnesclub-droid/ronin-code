import { useState } from 'react';
import { api, type MaturedIdea, type Mode } from '../lib/api';
import { useLang } from '../lib/i18n';

interface Props {
  open: boolean;
  mode: Mode;
  onClose: () => void;
  onBuilt: (path: string, idea: string) => void;
}

/** Idea section: one line in → audience, features, plan → Build it. */
export default function IdeaPanel({ open, mode, onClose, onBuilt }: Props) {
  const { t } = useLang();
  const [idea, setIdea] = useState('');
  const [matured, setMatured] = useState<MaturedIdea | null>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const mature = async () => {
    if (!idea.trim()) return;
    setBusy(true);
    setError('');
    try {
      setMatured(await api.matureIdea(idea.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    if (!matured) return;
    setBuilding(true);
    setError('');
    try {
      const res = await api.buildIdea(idea.trim(), matured);
      onBuilt(res.path, idea.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknown'));
    } finally {
      setBuilding(false);
    }
  };

  const reset = () => {
    setMatured(null);
    setError('');
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('idea.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('idea.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>×</button>
        </div>
        <p className="panel-sub">{t('idea.subtitle')}</p>

        {!matured ? (
          <>
            <textarea
              className="panel-textarea"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder={t('idea.placeholder')}
              aria-label={t('idea.title')}
            />
            {error && <p className="test-result test-result--bad">{error}</p>}
            <div className="modal-actions">
              <span />
              <button type="button" className="btn btn--primary" onClick={() => void mature()} disabled={busy || !idea.trim()}>
                {busy ? t('idea.thinking') : t('idea.mature')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="idea-cards">
              <div className="idea-card">
                <h3>{t('idea.audience')}</h3>
                <p>{matured.audience.who}</p>
                <p className="pain">{t('idea.pain')}: {matured.audience.pain}</p>
              </div>
              <div className="idea-card">
                <h3>{t('idea.features')}</h3>
                <ul>
                  {matured.features.map((f, i) => (<li key={i}>{f}</li>))}
                </ul>
              </div>
              <div className="idea-card">
                <h3>{t('idea.plan')}</h3>
                <ol>
                  {matured.plan.map((s, i) => (
                    <li key={i}>{s.title}{s.detail ? <> — <span>{s.detail}</span></> : null}</li>
                  ))}
                </ol>
              </div>
            </div>
            {mode === 'preview' && <p className="preview-note">{t('idea.previewNote')}</p>}
            {error && <p className="test-result test-result--bad">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn--ghost" onClick={reset} disabled={building}>
                {t('idea.again')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void build()} disabled={building}>
                {building ? t('idea.thinking') : t('idea.buildIt')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
