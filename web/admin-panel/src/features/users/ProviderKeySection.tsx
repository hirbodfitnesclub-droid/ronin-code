import { useCallback, useEffect, useState } from 'react';
import { api, hasCap, type Session } from '../../lib/api';
import {
  RESOLVE_DECISION_FA,
  buildProviderKeyView,
  classifyProviderKeyError,
  type ProviderKeyDetail,
  type ResolveDecision,
} from '../../lib/providerKey';
import { formatTokens } from '../../lib/format';
import { Card, ErrorBox, OkBox, Spinner, errText } from '../../components/ui/primitives';

/* Phase 2 — per-user provider key card in the user dossier (§7.4).
   Reads are cap finance_user; freeze/unfreeze cap risk_manage (intent-based,
   confirmation via the existing window.confirm pattern); needs_attention
   resolution is owner-only (§3.5). ALL display strings come from
   buildProviderKeyView — the component never renders raw key fields, and a
   403 (another user's data) lands in the standard error state, never a
   partial render (§IDOR battery). */
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
      setError('');
    } catch (e) {
      if (classifyProviderKeyError(e) === 'not_found') {
        // Shared-mode user (or key never issued): a legitimate empty state.
        setNotFound(true);
        setDetail(null);
      } else {
        // 403/401/5xx/network: standard error state, no partial data bleed.
        setDetail(null);
        setNotFound(false);
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

  async function resolve(intentId: string, decision: ResolveDecision) {
    const label = RESOLVE_DECISION_FA[decision];
    if (!window.confirm(`تصمیم «${label}» برای intent شماره ${intentId} ثبت شود؟ این اقدام در ممیزی ثبت می‌شود.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.resolveProviderIntent(intentId, decision);
      setOk(`تصمیم «${label}» ثبت شد.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!detail && !notFound && !error) return <Spinner />;
  const view = detail && detail.exists ? buildProviderKeyView(detail) : null;

  return (
    <Card
      title="کلید ارائه‌دهنده (Phase 2)"
      actions={
        view ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh()}>
            تازه‌سازی از ارائه‌دهنده
          </button>
        ) : undefined
      }
    >
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {!view ? (
        error ? null : (
          <p className="dim">برای این کاربر کلید ارائه‌دهنده‌ای صادر نشده است (حالت اشتراکی یا هنوز خرید تأییدشده‌ای ندارد).</p>
        )
      ) : (
        <>
          {view.attention.length > 0 ? (
            <div className="alert" role="alert" style={{ marginBottom: 14 }} data-testid="provider-attention-banner">
              <strong>نیازمند بررسی ({formatTokens(view.attention.length)} مورد):</strong>
              {view.attention.map((a) => (
                <div key={a.intentId} style={{ marginTop: 10 }}>
                  <div>{a.headline}</div>
                  {a.evidence ? (
                    <div className="small dim" style={{ marginTop: 4 }}>
                      {a.evidence}
                    </div>
                  ) : null}
                  {isOwner ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {a.decisions.map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          className={`btn btn-sm ${decision === 'abandon' ? 'btn-danger' : ''}`}
                          disabled={busy}
                          onClick={() => void resolve(a.intentId, decision)}
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
              <span className={`badge badge-${detail!.status}`}>{view.statusLabel}</span>
            </dd>
            <dt>کلید (ماسک‌شده)</dt>
            <dd className="ltr mono">{view.maskedKey}</dd>
            {view.kv.map((row) => (
              <div key={row.label} style={{ display: 'contents' }}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {row.label === 'موجودی ارائه‌دهنده' && view.balanceStale ? (
                    <span className="badge badge-warn" style={{ marginInlineStart: 8 }}>قدیمی</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>

          {canRisk ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn btn-danger" disabled={busy || !view.canFreeze} onClick={() => void freeze()}>
                فریز کلید
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !view.canUnfreeze} onClick={() => void unfreeze()}>
                رفع فریز کلید
              </button>
            </div>
          ) : null}

          <h3 style={{ marginTop: 20, marginBottom: 10 }}>تاریخچه شارژ و صدور (از پایگاه داده ما)</h3>
          {view.intentRows.length === 0 ? (
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
                  {view.intentRows.map((i) => (
                    <tr key={i.id}>
                      <td>{i.kindLabel}</td>
                      <td className="small mono">{i.source}</td>
                      <td>{i.amountText}</td>
                      <td>
                        <span className={`badge ${i.state === 'needs_attention' ? 'badge-warn' : ''}`}>{i.stateLabel}</span>
                      </td>
                      <td className="small">{i.actor}</td>
                      <td className="small dim">{i.dateText}</td>
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
