import { useCallback, useEffect, useState } from 'react';
import { api, type Checkpoint } from '../api';
import { useLang } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}

/** Named checkpoints: save the project's current state, restore it later. */
export default function CheckpointsPanel({ open, onClose, onRestored }: Props) {
  const { t, fmtNum } = useLang();
  const [list, setList] = useState<Checkpoint[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setList(await api.checkpoints()); } catch { /* panel shows empty state */ }
  }, []);

  useEffect(() => {
    if (open) {
      setNotice('');
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
      onRestored();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('checkpoints.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('checkpoints.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>×</button>
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
        {list.length === 0 ? (
          <p className="panel-sub">{t('checkpoints.empty')}</p>
        ) : (
          <div>
            {list.map((cp) => (
              <div key={cp.id} className="checkpoint-row">
                <span className="checkpoint-info">
                  <span className="checkpoint-name">{cp.name}</span>
                  <span className="checkpoint-meta">
                    {new Date(cp.ts).toLocaleString()} · {fmtNum(cp.files)}
                  </span>
                </span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void restore(cp)} disabled={busy}>
                  {t('checkpoints.restore')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
