import type { Starter } from '../../lib/api';
import { useLang } from '../../lib/i18n';

/* Ronin Code — starter picker modal: tasteful project templates. */

interface Props {
  open: boolean;
  starters: Starter[] | null;
  onClose: () => void;
  onPick: (starterId: string) => void;
}

export default function StartersModal(p: Props) {
  const { t, lang } = useLang();
  if (!p.open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={p.onClose} role="presentation">
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('starters.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t('starters.title')}</h2>
          <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </div>
        <div className="starters-grid">
          {(p.starters ?? []).map((s) => (
            <button key={s.id} type="button" className="starter-card" onClick={() => void p.onPick(s.id)}>
              <span className="starter-card-dot" style={{ background: s.accent }} />
              <span className="starter-card-name">{s.name[lang]}</span>
              <span className="starter-card-tag">{s.tagline[lang]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
