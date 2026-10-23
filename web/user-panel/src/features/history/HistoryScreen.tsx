import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Card, EmptyState, Spinner } from '../../components/ui';
import { api, isApiError, type CreditsResult, type LedgerKind, type LedgerRow } from '../../lib/api';
import { ERROR_CODE_KEYS, useLang, type LangCtx, type StringKey } from '../../lib/i18n';
import { RecentActivity } from './RecentActivity';
import './history.css';

type Filter = 'all' | 'consume' | 'purchase';

const KIND_KEYS: Record<LedgerKind, StringKey> = {
  purchase: 'history.kindPurchase',
  consume: 'history.kindConsume',
  hold: 'history.kindHold',
  release: 'history.kindRelease',
  adjust: 'history.kindAdjust',
  expire: 'history.kindExpire',
};

function errorText(e: unknown, t: LangCtx['t']): string {
  if (isApiError(e)) {
    const key = ERROR_CODE_KEYS[e.code];
    if (key) return t(key);
    if (e.code === 'network') return t('errors.network');
  }
  return t('errors.unknown');
}

function KindIcon({ kind }: { kind: LedgerKind }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    'aria-hidden': true,
  } as const;
  switch (kind) {
    case 'purchase':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'consume':
      return (
        <svg {...common}>
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
      );
    case 'hold':
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );
    case 'release':
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 7.7-1.5" />
        </svg>
      );
    case 'adjust':
      return (
        <svg {...common}>
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      );
    case 'expire':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
  }
}

function LedgerRowView({ row }: { row: LedgerRow }) {
  const { t, fmtNum, fmtDate, lang } = useLang();
  const kindLabel = t(KIND_KEYS[row.kind]);

  let title = kindLabel;
  let sub: ReactNode = null;
  if (row.kind === 'consume') {
    if (row.model) {
      title = `${kindLabel} `;
      sub = row.multiplier != null ? t('history.multiplier', { multiplier: row.multiplier }) : null;
    }
  } else if (row.kind === 'purchase') {
    const ref = row.note ?? (row.refId ? `${row.refType ?? ''} ${row.refId}`.trim() : row.refType);
    sub = ref ?? null;
  } else if (row.note) {
    sub = row.note;
  }

  const d = new Date(row.createdAt);
  const time = Number.isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(d);
  const deltaCls =
    row.deltaTokens > 0 ? 'history-delta-pos' : row.deltaTokens < 0 ? 'history-delta-neg' : 'history-delta-zero';

  return (
    <div className="history-row">
      <span className="history-icon">
        <KindIcon kind={row.kind} />
      </span>
      <div className="history-row-main">
        <div className="history-row-title">
          {title}
          {row.kind === 'consume' && row.model ? <span className="ltr-island">{row.model}</span> : null}
        </div>
        {sub ? <div className="history-row-sub">{sub}</div> : null}
        <div className="history-date">
          {fmtDate(row.createdAt)}
          {time ? ` · ${time}` : ''}
        </div>
      </div>
      <div className="history-row-side">
        <div className={`history-delta ${deltaCls}`}>
          <span className="ltr-island">
            {row.deltaTokens > 0 ? '+' : ''}
            {fmtNum(row.deltaTokens)}
          </span>
        </div>
        <div className="history-balance-after">{t('history.balanceAfter', { amount: fmtNum(row.balanceAfter) })}</div>
      </div>
    </div>
  );
}

/* Screen 5 — usage & transactions (server ledger, latest 50). */
export function HistoryScreen() {
  const { t, fmtNum } = useLang();
  const [data, setData] = useState<CreditsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(() => {
    let alive = true;
    api
      .credits()
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e, t));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(load, [load]);

  const rows = (data?.ledger ?? []).filter((r) =>
    filter === 'all' ? true : filter === 'consume' ? r.kind === 'consume' : r.kind === 'purchase',
  );

  return (
    <div>
      <RecentActivity />
      <Card>
        <h1 className="page-title">{t('history.title')}</h1>
        {data === null && !error ? (
          <div className="history-center">
            <Spinner />
            <span>{t('common.loading')}</span>
          </div>
        ) : error ? (
          <div className="history-center">
            <span className="error-text">{error}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setData(null);
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        ) : data ? (
          <>
            <div className="history-balance">
              <div className="history-balance-item">
                <span className="history-balance-label">{t('dashboard.balance')}</span>
                <span className="history-balance-value">
                  <span className="ltr-island">{fmtNum(data.balanceTokens)}</span> {t('common.tokens')}
                </span>
              </div>
              <div className="history-balance-item">
                <span className="history-balance-label">{t('dashboard.spendable')}</span>
                <span className="history-balance-value">
                  <span className="ltr-island">{fmtNum(data.spendableTokens)}</span> {t('common.tokens')}
                </span>
              </div>
            </div>
            <div className="history-filters" role="tablist">
              {(
                [
                  { id: 'all', key: 'history.filterAll' },
                  { id: 'consume', key: 'history.filterConsume' },
                  { id: 'purchase', key: 'history.filterPurchase' },
                ] as Array<{ id: Filter; key: StringKey }>
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={filter === f.id ? 'history-filter is-active' : 'history-filter'}
                  onClick={() => setFilter(f.id)}
                >
                  {t(f.key)}
                </button>
              ))}
            </div>
            {rows.length === 0 ? (
              <EmptyState title={t('history.title')} body={t('history.empty')} />
            ) : (
              <>
                <div className="history-list">
                  {rows.map((row) => (
                    <LedgerRowView key={row.id} row={row} />
                  ))}
                </div>
                <div className="history-note">{t('history.latestNote')}</div>
              </>
            )}
          </>
        ) : null}
      </Card>
    </div>
  );
}
