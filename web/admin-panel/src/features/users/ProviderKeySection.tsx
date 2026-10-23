import { useCallback, useEffect, useState } from 'react';
import { api, hasCap, type Session } from '../../lib/api';
import {
  PROVIDER_INTENT_KIND_FA,
  PROVIDER_INTENT_STATE_FA,
  PROVIDER_KEY_STATUS_FA,
  RESOLVE_DECISION_FA,
  canFreeze,
  canUnfreeze,
  maskedProviderKey,
  remainingObserved,
  resolveDecisionsFor,
  type ProviderIntent,
  type ProviderKeyDetail,
  type ResolveDecision,
} from '../../lib/providerKey';
import { formatDateTime, formatTokens } from '../../lib/format';
import { Card, ErrorBox, OkBox, Spinner, errText } from '../../components/ui/primitives';

/* Phase 2 — per-user provider key card in the user dossier (§7.4).
   Reads are cap finance_user; freeze/unfreeze cap risk_manage (intent-based,
   confirmation via the existing window.confirm pattern); needs_attention
   resolution is owner-only (§3.5). The key itself is never shown — last-4 only. */
export default function ProviderKeySection({ userId, session }: { userId: string; session: Session }) {
  const [detail, setDetail] = useState<ProviderKeyDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const canRisk = hasCap(session, 'risk_manage');
  const isOwner = session.role === 'owner';

  const load = useCallback(async () => {
    try {
      const r = await api.providerKey(userId);
      setDetail(r.providerKey);
      setNotFound(false);
    } catch (e) {
      const err = e as { status?: number; code?: string };
      if (err.status === 404 || err.code === 'not_found') {
        // Shared-mode user (or key never issued): a legitimate empty state.
        setNotFound(true);
        setDetail(null);
      } else {
        setError(errText(e));
      }
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const r = await api.refreshProviderKey(userId);
      setDetail(r.providerKey);
      setOk('موجودی و لاگ‌های ارائه‌دهنده تازه‌سازی شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function freeze() {
    if (!window.confirm('کلید ارائه‌دهنده این کاربر فریز شود؟ مصرف کاربر بلافاصله متوقف می‌شود.')) return;
    setBusy(true);
    setError('');
    try {
      await api.freezeProviderKey(userId);
      setOk('درخواست فریز کلید ثبت شد (در صف اجرا).');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function unfreeze() {
    if (!window.confirm('فریز کلید ارائه‌دهنده این کاربر برداشته شود؟')) return;
    setBusy(true);
    setError('');
    try {
      await api.unfreezeProviderKey(userId);
      setOk('درخواست رفع فریز کلید ثبت شد (در صف اجرا).');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolve(intent: ProviderIntent, decision: ResolveDecision) {
    const label = RESOLVE_DECISION_FA[decision];
    if (!window.confirm(`تصمیم «${label}» برای intent شماره ${intent.id} ثبت شود؟ این اقدام در ممیزی ثبت می‌شود.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.resolveProviderIntent(intent.id, decision);
      setOk(`تصمیم «${label}» ثبت شد.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!detail && !notFound && !error) return <Spinner />;

  return (
    <Card
      title="کلید ارائه‌دهنده (Phase 2)"
      actions={
        detail && detail.exists ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh()}>
            تازه‌سازی از ارائه‌دهنده
          </button>
        ) : undefined
      }
    >
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {notFound || !detail || !detail.exists ? (
        <p className="dim">برای این کاربر کلید ارائه‌دهنده‌ای صادر نشده است (حالت اشتراکی یا هنوز خرید تأییدشده‌ای ندارد).</p>
      ) : (
        <>
          {detail.attentionIntents.length > 0 ? (
            <div className="alert" role="alert" style={{ marginBottom: 14 }} data-testid="provider-attention-banner">
              <strong>نیازمند بررسی ({formatTokens(detail.attentionIntents.length)} مورد):</strong>
              {detail.attentionIntents.map((intent) => (
                <div key={intent.id} style={{ marginTop: 10 }}>
                  <div>
                    {PROVIDER_INTENT_KIND_FA[intent.kind] ?? intent.kind}
                    {intent.amountTokens ? ` — ${formatTokens(intent.amountTokens)} توکن` : ''} · از{' '}
                    {formatDateTime(intent.createdAt)} · تلاش‌ها: {formatTokens(intent.attemptCount)}
                    {intent.providerErrorCode ? (
                      <>
                        {' '}
                        · کد ارائه‌دهنده: <span className="ltr mono">{intent.providerErrorCode}</span>
                      </>
                    ) : null}
                  </div>
                  {intent.kind === 'topup' && (intent.balanceBefore !== null || intent.usedBefore !== null) ? (
                    <div className="small dim" style={{ marginTop: 4 }}>
                      شواهد موجودی — قبل از ارسال: موجودی {formatTokens(intent.balanceBefore)} · مصرف{' '}
                      {formatTokens(intent.usedBefore)} · موجودی فعلی مشاهده‌شده: {formatTokens(detail.balanceObserved)}
                    </div>
                  ) : null}
                  {isOwner ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {resolveDecisionsFor(intent).map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          className={`btn btn-sm ${decision === 'abandon' ? 'btn-danger' : ''}`}
                          disabled={busy}
                          onClick={() => void resolve(intent, decision)}
                        >
                          {RESOLVE_DECISION_FA[decision]}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="small dim" style={{ marginTop: 4 }}>
                      حل این مورد فقط توسط مالک انجام می‌شود.
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <dl className="kv">
            <dt>وضعیت کلید</dt>
            <dd>
              <span className={`badge badge-${detail.status}`}>{PROVIDER_KEY_STATUS_FA[detail.status] ?? detail.status}</span>
            </dd>
            <dt>کلید (ماسک‌شده)</dt>
            <dd className="ltr mono">{maskedProviderKey(detail.keyLast4)}</dd>
            <dt>سقف صادرشده</dt>
            <dd>{formatTokens(detail.tokenLimitIssued)} توکن</dd>
            <dt>مصرف مشاهده‌شده</dt>
            <dd>{formatTokens(detail.tokensUsedObserved)} توکن</dd>
            <dt>باقی‌مانده مشاهده‌شده</dt>
            <dd>{formatTokens(remainingObserved(detail))} توکن</dd>
            <dt>موجودی ارائه‌دهنده</dt>
            <dd>
              {formatTokens(detail.balanceObserved)} توکن
              {detail.balanceObservedAt ? (
                <span className="small faint"> — {formatDateTime(detail.balanceObservedAt)}</span>
              ) : null}
              {detail.balanceStale ? <span className="badge badge-warn" style={{ marginInlineStart: 8 }}>قدیمی</span> : null}
            </dd>
            {detail.convertedAt ? (
              <>
                <dt>تبدیل از نسخه ۱</dt>
                <dd>
                  {formatTokens(detail.convertedTokens)} توکن — {formatDateTime(detail.convertedAt)}
                </dd>
              </>
            ) : null}
            <dt>پرچم انحراف باز</dt>
            <dd>{formatTokens(detail.openDriftFlags)}</dd>
            <dt>آخرین تطبیق</dt>
            <dd>{formatDateTime(detail.lastReconciledAt)}</dd>
          </dl>

          {canRisk ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn btn-danger" disabled={busy || !canFreeze(detail)} onClick={() => void freeze()}>
                فریز کلید
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !canUnfreeze(detail)} onClick={() => void unfreeze()}>
                رفع فریز کلید
              </button>
            </div>
          ) : null}

          <h3 style={{ marginTop: 20, marginBottom: 10 }}>تاریخچه شارژ و صدور (از پایگاه داده ما)</h3>
          {detail.intents.length === 0 ? (
            <p className="dim">رکوردی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="data" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>نوع</th>
                    <th>منبع</th>
                    <th>مقدار</th>
                    <th>وضعیت</th>
                    <th>انجام‌دهنده</th>
                    <th>تاریخ</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.intents.map((i) => (
                    <tr key={i.id}>
                      <td>{PROVIDER_INTENT_KIND_FA[i.kind] ?? i.kind}</td>
                      <td className="small mono">{i.source}</td>
                      <td>{i.amountTokens !== null ? formatTokens(i.amountTokens) : '—'}</td>
                      <td>
                        <span className={`badge ${i.state === 'needs_attention' ? 'badge-warn' : ''}`}>
                          {PROVIDER_INTENT_STATE_FA[i.state] ?? i.state}
                        </span>
                      </td>
                      <td className="small">{i.actor ?? '—'}</td>
                      <td className="small dim">{formatDateTime(i.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
