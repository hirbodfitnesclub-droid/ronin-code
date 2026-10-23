import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, EmptyState, Spinner } from '../../components/ui';
import { api, isApiError, type Claim } from '../../lib/api';
import { ERROR_CODE_KEYS, useLang, type LangCtx } from '../../lib/i18n';
import { claimReasonText, issuanceNoteKey } from './claimDisplay';
import './purchases.css';

function errorText(e: unknown, t: LangCtx['t']): string {
  if (isApiError(e)) {
    const key = ERROR_CODE_KEYS[e.code];
    if (key) return t(key);
    if (e.code === 'network') return t('errors.network');
  }
  return t('errors.unknown');
}

function ReceiptIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}

function StatusChip({ claim }: { claim: Claim }) {
  const { t } = useLang();
  if (claim.status === 'pending') return <Chip tone="amber">{t('purchases.statusPending')}</Chip>;
  if (claim.status === 'approved') return <Chip tone="green">{t('purchases.statusApproved')}</Chip>;
  return <Chip tone="accent">{t('purchases.statusRejected')}</Chip>;
}

function ClaimRow({ claim }: { claim: Claim }) {
  const { t, fmtNum, fmtToman, fmtDate } = useLang();
  const reason = claimReasonText(claim, t('purchases.rejectGeneric'));
  const issuanceKey = issuanceNoteKey(claim);
  return (
    <div className="purchases-row">
      <div className="purchases-row-main">
        <div className="purchases-row-info">
          <div className="purchases-pack">
            {claim.packTitle}
            {claim.hasReceipt ? (
              <span className="purchases-receipt" title={t('purchases.receiptAttached')}>
                <ReceiptIcon />
              </span>
            ) : null}
          </div>
          <div className="purchases-meta">
            <span className="ltr-island">{fmtNum(claim.tokens)}</span>
            <span>{t('common.tokens')}</span>
            <span aria-hidden="true">·</span>
            <span>{fmtDate(claim.createdAt)}</span>
          </div>
        </div>
        <div className="purchases-price">
          <span className="ltr-island">{fmtToman(claim.priceRials)}</span> {t('common.toman')}
        </div>
        <StatusChip claim={claim} />
      </div>
      {claim.status === 'pending' ? <div className="purchases-note">{t('purchases.pendingNote')}</div> : null}
      {claim.status === 'approved' && claim.reviewedAt ? (
        <div className="purchases-note">{fmtDate(claim.reviewedAt)}</div>
      ) : null}
      {/* Phase 2 (§7.2): issuance state of the provider key for this purchase.
          needs_attention is shown as reassurance, never as an error. */}
      {issuanceKey === 'purchases.issuanceConfirmed' ? (
        <div className="purchases-note purchases-issuance-ok">{t(issuanceKey)}</div>
      ) : null}
      {issuanceKey === 'purchases.issuancePending' ? <div className="purchases-note">{t(issuanceKey)}</div> : null}
      {issuanceKey === 'purchases.issuanceAttention' ? (
        <div className="purchases-note purchases-issuance-attention">{t(issuanceKey)}</div>
      ) : null}
      {claim.status === 'rejected' ? (
        <div className="purchases-reject">
          <span className="purchases-reject-label">{t('purchases.rejectReason')}:</span>
          {reason}
        </div>
      ) : null}
    </div>
  );
}

/* Screen 4 — purchase status: receipt claims, newest first. */
export function PurchasesScreen() {
  const { t } = useLang();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    let alive = true;
    api
      .listClaims()
      .then((rows) => {
        if (!alive) return;
        setClaims([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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

  const goBuy = () => {
    // The shell owns view state (App.tsx) and passes no navigation prop to
    // screens; ask it to switch via a window event (see builder report).
    window.dispatchEvent(new CustomEvent('ronin:navigate', { detail: { view: 'buy' } }));
  };

  return (
    <div>
      <Card>
        <h1 className="page-title">{t('purchases.title')}</h1>
        {claims === null && !error ? (
          <div className="purchases-center">
            <Spinner />
            <span>{t('common.loading')}</span>
          </div>
        ) : error ? (
          <div className="purchases-center">
            <span className="error-text">{error}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setClaims(null);
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        ) : claims && claims.length === 0 ? (
          <>
            <EmptyState title={t('purchases.title')} body={t('purchases.empty')} />
            <div className="purchases-cta">
              <button type="button" className="btn btn-primary" onClick={goBuy}>
                {t('dashboard.buyCredit')}
              </button>
            </div>
          </>
        ) : (
          <div className="purchases-list">
            {(claims ?? []).map((claim) => (
              <ClaimRow key={claim.id} claim={claim} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
