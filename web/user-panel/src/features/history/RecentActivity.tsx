import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, EmptyState, Spinner } from '../../components/ui';
import { api, type RecentUsageResult } from '../../lib/api';
import { useLang } from '../../lib/i18n';

/* Phase 2 (§7.2): recent activity from the provider-logs-backed endpoint
   GET /api/usage/recent. The provider hard-caps this at the 30 most recent
   requests — the copy says exactly that and shows the all-time total beside
   it; it is never presented as complete history. In shared mode the API
   returns null and this section renders nothing. */
export function RecentActivity() {
  const { t, fmtNum, fmtDate, lang } = useLang();
  const [data, setData] = useState<RecentUsageResult | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    let alive = true;
    api
      .recentUsage()
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(load, [load]);

  if (data === undefined) {
    return (
      <Card>
        <h2 className="page-title">{t('history.recentTitle')}</h2>
        <div className="history-center">
          <Spinner />
          <span>{t('common.loading')}</span>
        </div>
      </Card>
    );
  }
  if (data === null) return null;

  return (
    <Card>
      <h2 className="page-title">{t('history.recentTitle')}</h2>
      <p className="history-recent-note">
        {t('history.recentNote')} · {t('history.recentTotal', { count: fmtNum(data.totalRequests) })}
      </p>
      {data.rows.length === 0 ? (
        <EmptyState title={t('history.recentTitle')} body={t('history.recentEmpty')} />
      ) : (
        <div className="history-list" data-testid="recent-usage-list">
          {data.rows.map((row, i) => {
            const d = new Date(row.createdAt);
            const time = Number.isNaN(d.getTime())
              ? ''
              : new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(d);
            return (
              <div className="history-row" key={`${row.createdAt}-${i}`}>
                <div className="history-row-main">
                  <div className="history-row-title">
                    <span className="ltr-island">{row.model}</span>
                    {row.fast ? <Chip tone="amber">{t('history.recentFast')}</Chip> : null}
                  </div>
                  <div className="history-row-sub">
                    {t('history.recentInOut', { input: fmtNum(row.inputTokens), output: fmtNum(row.outputTokens) })}
                    {row.cachedTokens > 0 ? ` · ${t('history.recentCached', { count: fmtNum(row.cachedTokens) })}` : ''}
                  </div>
                  <div className="history-date">
                    {fmtDate(row.createdAt)}
                    {time ? ` · ${time}` : ''}
                  </div>
                </div>
                <div className="history-row-side">
                  <div className="history-delta history-delta-neg">
                    <span className="ltr-island">{t('history.recentCost', { count: fmtNum(row.costTokens) })}</span>
                  </div>
                  <div className="history-balance-after">{row.status}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setData(undefined);
          setAttempt((n) => n + 1);
        }}
      >
        {t('common.retry')}
      </button>
    </Card>
  );
}
