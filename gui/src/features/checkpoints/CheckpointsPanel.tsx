import { useCallback, useEffect, useState } from 'react';
import { api, type Checkpoint } from '../../lib/api';
import { useLang } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}

/** Named checkpoints (RDX-06): save the project's current state,
    restore it later. Shown as a timeline, newest first; the newest is
    where the project currently stands. Restore always asks first,
    with the exact cost spelled out: everything after that point is
    lost. */
export default function CheckpointsPanel({ open, onClose, onRestored }: Props) {
  const { t, fmtNum } = useLang();
  const [list, setList] = useState<Checkpoint[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.checkpoints());
    } catch {
      /* panel shows empty state */
    }
  }, []);

  useEffect(() => {
    if (open) {
      setNotice('');
      setConfirmId(null);
      void load();
    }
  }, [open, load]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    try {
      await api.createCheckpoint(name.trim());
      setName('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const restore = async (cp: Checkpoint) => {
    setBusy(true);
    try {
      await api.restoreCheckpoint(cp.id);
      setNotice(t('checkpoints.restored', { name: cp.name }));
      setConfirmId(null);
      onRestored();
    } finally {
      setBusy(false);
    }
  };

  /* Newest first — the head of the timeline is the current state. */
  const sorted = [...list].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('checkpoints.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t('checkpoints.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </div>
        <div className="checkpoint-save-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('checkpoints.namePlaceholder')}
            aria-label={t('changes.checkpointName')}
          />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>
            {t('checkpoints.save')}
          </button>
        </div>
        {notice && <p className="test-result test-result--ok">{notice}</p>}
        {sorted.length === 0 ? (
          <p className="panel-sub">{t('checkpoints.empty')}</p>
        ) : (
          <div className="checkpoint-timeline">
            {sorted.map((cp, i) => (
              <div key={cp.id} className={`checkpoint-item ${i === 0 ? 'checkpoint-item--current' : ''}`}>
                <span className="checkpoint-node" aria-hidden="true" />
                <div className="checkpoint-body">
                  <span className="checkpoint-info">
                    <span className="checkpoint-name">
                      {cp.name}
                      {i === 0 && <span className="checkpoint-current-badge">{t('checkpoints.current')}</span>}
                    </span>
                    <span className="checkpoint-meta">
                      {new Date(cp.ts).toLocaleString()} · {t('checkpoints.filesCount', { count: fmtNum(cp.files) })}
                    </span>
                  </span>
                  {confirmId === cp.id ? (
                    <div className="checkpoint-confirm">
                      <p>{t('checkpoints.confirmRestore')}</p>
                      <div className="checkpoint-confirm-actions">
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => void restore(cp)}
                          disabled={busy}
                        >
                          {t('checkpoints.confirmYes')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setConfirmId(null)}
                          disabled={busy}
                        >
                          {t('auth.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setConfirmId(cp.id)}
                      disabled={busy || i === 0}
                    >
                      {t('checkpoints.restore')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
