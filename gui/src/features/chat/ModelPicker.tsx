import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModel } from '../../lib/catalog';
import { coeffLabel, groupByFamily, modelById } from '../../lib/models';
import { useLang, type StringKey } from '../../lib/i18n';
import FamilyMark from '../../components/ui/FamilyMark';

/* Ronin Code — composer model picker: a toolbar row of chips
   [model ▾] [effort ▾] [⚡ Fast]. The popover lists ONLY the enabled
   models, grouped by family. Effort/Fast chips appear only when the
   active model actually supports them. */

const EFFORT_KEYS: Record<string, StringKey> = {
  none: 'picker.effort.none',
  low: 'picker.effort.low',
  medium: 'picker.effort.medium',
  high: 'picker.effort.high',
  xhigh: 'picker.effort.xhigh',
  max: 'picker.effort.max',
  thinking: 'picker.effort.thinking',
};

interface Props {
  enabledModels: string[];
  modelId: string | null;
  activeModel: CatalogModel | undefined;
  effort: string | null;
  effortOptions: string[];
  fast: boolean;
  fastAvailable: boolean;
  onSelectModel: (id: string) => void;
  onEffortChange: (effort: string) => void;
  onFastChange: (fast: boolean) => void;
}

export default function ModelPicker(p: Props) {
  const { t } = useLang();
  const [open, setOpen] = useState<'model' | 'effort' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const models = p.enabledModels.map((id_) => modelById(id_)).filter((m): m is CatalogModel => Boolean(m));
    return groupByFamily(models);
  }, [p.enabledModels]);

  /* Close popovers on outside click / Escape. */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const effortLabel = (e: string) => {
    const key = EFFORT_KEYS[e];
    return key ? t(key) : e;
  };

  const chevron = (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="picker-chevron">
      <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="picker-chip"
        onClick={() => setOpen(open === 'model' ? null : 'model')}
        aria-haspopup="listbox"
        aria-expanded={open === 'model'}
        aria-label={t('picker.model')}
      >
        {p.activeModel && <FamilyMark family={p.activeModel.family} size={15} />}
        <span className="picker-chip-name">{p.activeModel?.name ?? t('picker.model')}</span>
        {chevron}
      </button>

      {p.effortOptions.length > 0 && p.effort && (
        <button
          type="button"
          className="picker-chip"
          onClick={() => setOpen(open === 'effort' ? null : 'effort')}
          aria-haspopup="listbox"
          aria-expanded={open === 'effort'}
          aria-label={t('picker.effort')}
        >
          <span className="picker-chip-name">{effortLabel(p.effort)}</span>
          {chevron}
        </button>
      )}

      {p.fastAvailable && (
        <button
          type="button"
          className={`fast-toggle ${p.fast ? 'fast-toggle--on' : ''}`}
          onClick={() => p.onFastChange(!p.fast)}
          aria-pressed={p.fast}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6.8 1 2.6 6.8h2.5L4.4 11 9.4 5H6.9L6.8 1Z" fill="currentColor" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
          </svg>
          {t('picker.fast')}
        </button>
      )}

      {open === 'model' && (
        <div className="picker-popover" role="listbox" aria-label={t('picker.model')}>
          {groups.map((g) => (
            <div key={g.family} className="picker-group">
              <div className="picker-group-title">
                <FamilyMark family={g.family} size={13} />
                <span>{g.family}</span>
              </div>
              {g.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === p.modelId}
                  className={`picker-row ${m.id === p.modelId ? 'picker-row--active' : ''}`}
                  onClick={() => {
                    p.onSelectModel(m.id);
                    setOpen(null);
                  }}
                >
                  <FamilyMark family={m.family} size={15} />
                  <span className="picker-row-name">{m.name}</span>
                  <span className="coeff-badge" dir="ltr">
                    {coeffLabel(m.coeff)}
                  </span>
                  {m.id === p.modelId && (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="picker-check">
                      <path d="M2.5 7.5 5.8 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="picker-empty">{t('picker.model')}</p>}
        </div>
      )}

      {open === 'effort' && (
        <div className="picker-popover picker-popover--effort" role="listbox" aria-label={t('picker.effort')}>
          {p.effortOptions.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={e === p.effort}
              className={`picker-row ${e === p.effort ? 'picker-row--active' : ''}`}
              onClick={() => {
                p.onEffortChange(e);
                setOpen(null);
              }}
            >
              <span className="picker-row-name">{effortLabel(e)}</span>
              {e === p.effort && (
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="picker-check">
                  <path d="M2.5 7.5 5.8 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
