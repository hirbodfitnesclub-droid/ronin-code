import { useMemo, useState } from 'react';
import { CATALOG } from '../../lib/catalog';
import { coeffLabel, groupByFamily, hasFast } from '../../lib/models';
import { useLang } from '../../lib/i18n';
import FamilyMark from '../../components/ui/FamilyMark';

/* Ronin Code — multi-select over all 44 catalog models, grouped by
   family with a filter box. Shared by first-run onboarding and the
   Settings → Models section. Value = selected model ids. */

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

export default function ModelMultiSelect({ value, onChange }: Props) {
  const { t, fmtNum } = useLang();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? CATALOG.filter(
          (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.family.toLowerCase().includes(q),
        )
      : CATALOG;
    return groupByFamily(filtered);
  }, [query]);

  const toggle = (id_: string) => {
    onChange(value.includes(id_) ? value.filter((x) => x !== id_) : [...value, id_]);
  };

  return (
    <div className="model-multi">
      <input
        type="search"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        className="model-multi-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('settings.models.search')}
        aria-label={t('settings.models.search')}
      />
      <p className="model-multi-count">{t('settings.models.selected', { count: fmtNum(value.length) })}</p>
      <div className="model-multi-list">
        {groups.map((g) => (
          <div key={g.family} className="model-multi-group">
            <div className="picker-group-title">
              <FamilyMark family={g.family} size={13} />
              <span>{g.family}</span>
            </div>
            {g.models.map((m) => {
              const checked = value.includes(m.id);
              return (
                <label key={m.id} className={`model-row ${checked ? 'model-row--on' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(m.id)} />
                  <FamilyMark family={m.family} size={15} />
                  <span className="model-row-name">{m.name}</span>
                  <span className="coeff-badge" dir="ltr">
                    {coeffLabel(m.coeff)}
                  </span>
                  {hasFast(m) && <span className="fast-badge">{t('settings.models.fast')}</span>}
                </label>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && <p className="picker-empty">{t('settings.models.search')}</p>}
      </div>
    </div>
  );
}
