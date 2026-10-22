import type { Provider } from '../../lib/api';
import { useLang } from '../../lib/i18n';

/* Ronin Code — settings: router & failover section. Multi-key list with
   per-key stats/cooldown, extra-key rows, failover toggle + order. */

interface KeyInfo {
  index: number;
  maskedKey: string;
  requests: number;
  coolingDown: boolean;
}

interface Props {
  keys: KeyInfo[];
  extraKeys: string[];
  onExtraKeysChange: (next: string[]) => void;
  failoverOn: boolean;
  onFailoverToggle: () => void;
  others: Provider[];
  failoverOrder: string[];
  onFailoverOrderChange: (next: string[]) => void;
  rtkSaved: number;
  onRemoveKey: (index: number) => void;
}

export default function RouterSection(p: Props) {
  const { t, fmtNum } = useLang();
  return (
      <div className="settings-section">
        <h3>{t('settings.router')}</h3>
        <span className="field-hint">{t('settings.routerHint')}</span>

        {p.keys.map((k) => (
          <div key={k.index} className="key-row">
            <span className="key-stats" dir="ltr">{k.maskedKey}</span>
            <span className="key-stats">
              {t('settings.requests', { count: fmtNum(k.requests) })}
              {k.coolingDown && <span className="cooling"> · {t('settings.cooling')}</span>}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void p.onRemoveKey(k.index)}>
              {t('settings.removeKey')}
            </button>
          </div>
        ))}

        {p.extraKeys.map((v, i) => (
          <div key={i} className="key-row">
            <input
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={v}
              onChange={(e) => {
                const next = [...p.extraKeys];
                next[i] = e.target.value;
                p.onExtraKeysChange(next);
              }}
              placeholder={t('settings.apiKeyPlaceholder')}
              aria-label={t('settings.keyN', { n: i + 2 })}
            />
            {i === p.extraKeys.length - 1 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => p.onExtraKeysChange([...p.extraKeys, ''])}>
                {t('settings.addKey')}
              </button>
            )}
          </div>
        ))}

        <div className="switch-row">
          <span className="switch-label">{t('settings.failover')}</span>
          <button
            type="button"
            className={`switch ${p.failoverOn ? 'switch--on' : ''}`}
            onClick={p.onFailoverToggle}
            aria-pressed={p.failoverOn}
            aria-label={t('settings.failover')}
          />
        </div>

        {p.failoverOn && p.others.length > 0 && (
          <label className="field">
            <span className="field-label">{t('settings.failoverOrder')}</span>
            <select
              className="failover-select"
              value={p.failoverOrder[0] ?? ''}
              onChange={(e) => {
                const first = e.target.value;
                const rest = p.others.map((x) => x.id).filter((x) => x !== first);
                p.onFailoverOrderChange(first ? [first, ...rest] : []);
              }}
            >
              <option value="">—</option>
              {p.others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {p.rtkSaved > 0 && <span className="field-hint">{t('settings.rtkSaved', { chars: fmtNum(p.rtkSaved) })}</span>}
      </div>
  );
}
