import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, EmptyState, Spinner } from '../../components/ui';
import { api, type Pack, type PacksResult } from '../../lib/api';
import { useLang, type StringKey } from '../../lib/i18n';
import type { View } from '../../lib/view';
import { ClaimCard } from './ClaimCard';
import './buy.css';

function groupCardNumber(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (digits.length !== 16) return number;
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function badgeKey(badge: string): StringKey | null {
  if (badge === 'popular') return 'buy.badgePopular';
  if (badge === 'bestValue') return 'buy.badgeBestValue';
  return null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value stays visible for manual copying */
    }
  };
  return (
    <button type="button" className="btn buy-copy-btn" onClick={copy} aria-label={label}>
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  );
}

function CoinIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="buy-pack-icon">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 5.5V12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 12v6.5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V12" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
    </svg>
  );
}

export function BuyScreen({ onNavigate }: { onNavigate?: (v: View) => void } = {}) {
  const { t, fmtNum, fmtToman } = useLang();
  const [result, setResult] = useState<PacksResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await api.packs();
      setResult(r);
      setSelectedId((prev) => {
        if (prev && r.packs.some((p) => p.id === prev)) return prev;
        return (r.packs.find((p) => p.badge === 'popular') ?? r.packs[0])?.id ?? null;
      });
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  const goPurchases = () => {
    if (onNavigate) onNavigate('purchases');
    else window.dispatchEvent(new CustomEvent('ronin:navigate', { detail: 'purchases' }));
  };

  if (failed) {
    return (
      <Card className="buy-error-card">
        <p className="buy-muted">{t('errors.unknown')}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setResult(null);
            setReloadTick((n) => n + 1);
          }}
        >
          {t('common.retry')}
        </button>
      </Card>
    );
  }

  if (!result) {
    return (
      <div className="buy-loading" aria-busy="true">
        <Spinner />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  const selected: Pack | null = result.packs.find((p) => p.id === selectedId) ?? null;
  const cardDigits = result.card.number.replace(/\D/g, '');

  return (
    <div>
      <h1 className="page-title">{t('buy.title')}</h1>
      <p className="page-sub">{t('buy.subtitle')}</p>

      {result.packs.length === 0 ? (
        <Card>
          <EmptyState title={t('common.noResults')} body={t('buy.subtitle')} />
        </Card>
      ) : (
        <>
          <div className="buy-grid" role="radiogroup" aria-label={t('buy.title')}>
            {result.packs.map((pack) => {
              const isSelected = pack.id === selectedId;
              const badge = pack.badge ? badgeKey(pack.badge) : null;
              return (
                <button
                  key={pack.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={isSelected ? 'buy-pack is-selected' : 'buy-pack'}
                  onClick={() => setSelectedId(pack.id)}
                >
                  {pack.badge ? (
                    <span className="buy-pack-badge">
                      <Chip tone="accent">{badge ? t(badge) : pack.badge}</Chip>
                    </span>
                  ) : null}
                  <CoinIcon />
                  <span className="buy-pack-tokens ltr-island">{fmtNum(pack.tokens)}</span>
                  <span className="buy-pack-unit">{t('common.tokens')}</span>
                  <span className="buy-pack-price">
                    {pack.priceRials > 0 ? (
                      <>
                        <span className="ltr-island">{fmtToman(pack.priceRials)}</span> {t('common.toman')}
                      </>
                    ) : (
                      <span className="ltr-island">${fmtNum(pack.usd)}</span>
                    )}
                  </span>
                  {pack.validityDays ? (
                    <span className="buy-pack-validity">{t('buy.validity', { days: fmtNum(pack.validityDays) })}</span>
                  ) : null}
                  <span className="buy-pack-select">{isSelected ? t('buy.selected') : t('buy.selectPack')}</span>
                </button>
              );
            })}
          </div>

          <Card className="buy-shopcard">
            <h2 className="buy-card-title">{t('buy.payTo')}</h2>
            <div className="buy-card-row">
              <span className="buy-card-label">{t('buy.cardBank')}</span>
              <span className="buy-card-value">{result.card.bank}</span>
            </div>
            <div className="buy-card-row">
              <span className="buy-card-label">{t('buy.cardNumber')}</span>
              <span className="buy-card-value ltr-island">{groupCardNumber(result.card.number)}</span>
              <CopyButton value={cardDigits || result.card.number} label={t('buy.cardNumber')} />
            </div>
            <div className="buy-card-row">
              <span className="buy-card-label">{t('buy.cardHolder')}</span>
              <span className="buy-card-value">{result.card.holder}</span>
              <CopyButton value={result.card.holder} label={t('buy.cardHolder')} />
            </div>
          </Card>

          <ClaimCard pack={selected} onGoPurchases={goPurchases} />

          <Card className="buy-steps">
            <h2 className="buy-card-title">{t('buy.stepsTitle')}</h2>
            <ol className="buy-steps-list">
              <li>{t('buy.step1')}</li>
              <li>{t('buy.step2')}</li>
              <li>{t('buy.step3')}</li>
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
