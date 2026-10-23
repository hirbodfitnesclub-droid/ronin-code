import { useCallback, useEffect, useState } from 'react';
import { Card, Chip } from '../../components/ui';
import { api, type AccountStatus, type MeResult, type UsageSummary } from '../../lib/api';
import { isProviderBalanceUnavailable, maskedKeyHint } from '../../lib/api/usage';
import { useLang, type StringKey } from '../../lib/i18n';
import type { View } from '../../lib/view';
import { WeekChart } from './WeekChart';
import './dashboard.css';

interface DashData {
  me: MeResult;
  status: AccountStatus;
  usage: UsageSummary;
  /** Rial-per-token derived from the first priced pack (display only). */
  rateRialsPerToken: number | null;
}

export function DashboardScreen({ onNavigate }: { onNavigate?: (v: View) => void } = {}) {
  const { t, fmtNum, fmtToman, fmtDate } = useLang();
  const [data, setData] = useState<DashData | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [me, status, usage, packsResult] = await Promise.all([
        api.me(),
        api.accountStatus(),
        api.usageSummary(),
        api.packs().catch(() => null),
      ]);
      const priced = packsResult?.packs.find((p) => p.priceRials > 0 && p.tokens > 0);
      setData({ me, status, usage, rateRialsPerToken: priced ? priced.priceRials / priced.tokens : null });
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  const goBuy = () => {
    if (onNavigate) onNavigate('buy');
    else window.dispatchEvent(new CustomEvent('ronin:navigate', { detail: 'buy' }));
  };

  if (failed) {
    return (
      <Card className="dash-error">
        <p className="dash-error-text">{t('errors.unknown')}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setData(null);
            setReloadTick((n) => n + 1);
          }}
        >
          {t('common.retry')}
        </button>
      </Card>
    );
  }

  if (!data) {
    return (
      <div aria-busy="true" aria-label={t('common.loading')}>
        <div className="skeleton skeleton-line skeleton-wide" />
        <div className="skeleton skeleton-balance" />
        <div className="dash-stats">
          <div className="skeleton skeleton-stat" />
          <div className="skeleton skeleton-stat" />
        </div>
        <div className="skeleton skeleton-chart" />
      </div>
    );
  }

  const { me, status, usage } = data;
  const fullName = me.user.name?.trim() || me.user.phone;
  const firstName = fullName.split(/\s+/)[0] ?? fullName;
  const tomanRials = data.rateRialsPerToken !== null ? Math.round(me.balanceTokens * data.rateRialsPerToken) : null;
  const expiringLot = status.lots.find((lot) => lot.expiresAt);
  const topTotal = usage.topModels.reduce((sum, m) => sum + m.tokens, 0);
  /* Phase 2 (§7.1): in per-user mode the balance is the provider-backed figure
     already substituted into me/status by the server; providerKey carries the
     key status + staleness. Shared-mode users see none of this. */
  const perUser = (status.routingMode ?? me.routingMode) === 'per_user';
  const providerKey = status.providerKey ?? me.providerKey ?? null;
  const balanceUnavailable = perUser && isProviderBalanceUnavailable(providerKey);
  const keyHint = perUser ? maskedKeyHint(providerKey?.keyLast4) : null;

  return (
    <div>
      <header className="dash-head">
        <h1 className="page-title">{t('dashboard.greeting', { name: firstName })}</h1>
        <p className="page-sub">{t('app.tagline')}</p>
      </header>

      <Card className="dash-balance">
        <div className="dash-balance-label">{t('dashboard.balance')}</div>
        {balanceUnavailable ? (
          <p className="dash-balance-unavailable">{t('dashboard.balanceUnavailable')}</p>
        ) : (
          <>
            <div className="dash-balance-value ltr-island">{fmtNum(me.balanceTokens)}</div>
            <div className="dash-balance-unit">{t('common.tokens')}</div>
          </>
        )}
        {!perUser && me.spendableTokens !== me.balanceTokens ? (
          <div className="dash-spendable">
            {t('dashboard.spendable')}: <span className="ltr-island">{fmtNum(me.spendableTokens)}</span>
          </div>
        ) : null}
        {!balanceUnavailable && tomanRials !== null ? (
          <div className="dash-toman">{t('dashboard.tomanEquivalent', { amount: fmtToman(tomanRials) })}</div>
        ) : null}
        {perUser && !balanceUnavailable ? <div className="dash-toman">{t('dashboard.perUserNote')}</div> : null}
        {perUser && providerKey?.balanceStale && !balanceUnavailable ? (
          <div className="dash-stale">{t('dashboard.balanceStale')}</div>
        ) : null}
        <button type="button" className="btn btn-primary dash-buy-btn" onClick={goBuy}>
          {t('dashboard.buyCredit')}
        </button>
      </Card>

      <div className="dash-stats">
        <Card className="dash-stat">
          <span className="dash-stat-icon" aria-hidden="true">
            ⚡
          </span>
          <div>
            <div className="dash-stat-label">{t('dashboard.todayUsage')}</div>
            <div className="dash-stat-value">
              <span className="ltr-island">{fmtNum(usage.todayTokens)}</span> {t('common.tokens')}
            </div>
          </div>
        </Card>
        <Card className="dash-stat">
          <span className="dash-stat-icon" aria-hidden="true">
            📅
          </span>
          <div>
            <div className="dash-stat-label">{t('dashboard.monthUsage')}</div>
            <div className="dash-stat-value">
              <span className="ltr-island">{fmtNum(usage.monthTokens)}</span> {t('common.tokens')}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="dash-card-title">{t('dashboard.last7Days')}</h2>
        {usage.last7Days.length > 0 ? (
          <WeekChart days={usage.last7Days} />
        ) : (
          <p className="dash-empty-note">{t('dashboard.noUsage')}</p>
        )}
        {usage.hasPartialDays ? <p className="dash-partial-note">{t('dashboard.partialNote')}</p> : null}
      </Card>

      <Card>
        <h2 className="dash-card-title">{t('dashboard.planStatus')}</h2>
        <div className="dash-status-row">
          {status.isActive ? <Chip tone="green">{t('dashboard.active')}</Chip> : <Chip>{t('dashboard.inactive')}</Chip>}
          <span className="dash-status-devices">
            {t('dashboard.activeDevices', { count: fmtNum(status.activeDevices) })}
          </span>
        </div>
        {expiringLot?.expiresAt ? (
          <p className="dash-expiry">
            {t('dashboard.expiringSoon', {
              count: fmtNum(expiringLot.tokensLeft),
              date: fmtDate(expiringLot.expiresAt),
            })}
          </p>
        ) : null}
        {perUser && providerKey ? (
          <div className="dash-key-row" data-testid="provider-key-summary">
            <span className="dash-key-label">{t('dashboard.providerKey')}</span>
            <Chip
              tone={providerKey.status === 'active' ? 'green' : providerKey.status === 'frozen' ? 'accent' : 'amber'}
            >
              {t(`dashboard.keyStatus.${providerKey.status}` as StringKey)}
            </Chip>
            <span className="dash-key-issued">
              {t('dashboard.keyIssued', { count: fmtNum(providerKey.tokenLimitIssued) })}
            </span>
            {keyHint ? (
              <span className="dash-key-hint">
                {t('dashboard.keyLabel')} <span className="ltr-island">{keyHint}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {usage.topModels.length > 0 ? (
        <Card>
          <h2 className="dash-card-title">{t('dashboard.topModels')}</h2>
          <ul className="dash-models">
            {usage.topModels.map((m, i) => {
              const pct = topTotal > 0 ? Math.round((m.tokens / topTotal) * 100) : 0;
              return (
                <li key={m.model} className="dash-model">
                  <span className="dash-model-rank ltr-island">{i + 1}</span>
                  <span className="dash-model-name ltr-island">{m.model}</span>
                  <span className="dash-model-tokens ltr-island">{fmtNum(m.tokens)}</span>
                  <span className="dash-model-pct ltr-island">{pct}%</span>
                  <span className="dash-model-bar" aria-hidden="true">
                    <span style={{ width: `${pct}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
