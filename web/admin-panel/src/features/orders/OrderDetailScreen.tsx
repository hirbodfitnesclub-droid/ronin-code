import { useCallback, useEffect, useRef, useState } from 'react';
import { api, hasCap, type Order, type Refund, type Session } from '../../lib/api';
import { formatDateTime, formatToman, formatTokens, rialsToTomanInput, tomanToRials } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Card, ErrorBox, Field, Modal, OkBox, Spinner, StatusBadge, errText } from '../../components/ui/primitives';

interface Detail {
  order: Order;
  user: { id: string; phone: string; name: string | null };
  refunds: Refund[];
}

export default function OrderDetailScreen({ id, session }: { id: string; session: Session }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [receiptError, setReceiptError] = useState(false);

  const [receivedToman, setReceivedToman] = useState('');
  const [approveNote, setApproveNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNote, setRejectNote] = useState('');

  const [showRefund, setShowRefund] = useState(false);
  const [refundToman, setRefundToman] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundRef, setRefundRef] = useState('');
  const idempotencyKey = useRef('');

  const load = useCallback(async () => {
    try {
      const d = await api.order(id);
      setDetail(d);
      setReceivedToman(rialsToTomanInput(d.order.receivedAmountRials ?? d.order.priceRials));
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail && !error) return <Spinner />;
  if (!detail) return <ErrorBox message={error} />;
  const { order, user, refunds } = detail;
  const isOwner = session.role === 'owner';
  const canRefund = hasCap(session, 'refund_write');

  async function review(action: 'approve' | 'reject') {
    setBusy(true);
    setError('');
    setOk('');
    try {
      const body =
        action === 'approve'
          ? { action, receivedAmountRials: tomanToRials(receivedToman), note: approveNote || undefined }
          : { action, reason: rejectReason, note: rejectNote || undefined };
      const r = await api.reviewOrder(id, body);
      setOk(
        action === 'approve'
          ? `سفارش تأیید شد و ${formatTokens(r.grantedTokens)} توکن اعطا شد.`
          : 'سفارش رد شد.',
      );
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function openRefund() {
    idempotencyKey.current = crypto.randomUUID();
    setRefundToman('');
    setRefundReason('');
    setRefundRef('');
    setShowRefund(true);
  }

  async function submitRefund() {
    setBusy(true);
    setError('');
    try {
      const r = await api.refundOrder(id, {
        amountRials: tomanToRials(refundToman),
        reason: refundReason,
        reference: refundRef || undefined,
        idempotencyKey: idempotencyKey.current,
      });
      setOk(
        r.replayed
          ? 'این بازگشت وجه قبلاً ثبت شده بود (تکراری محسوب نشد).'
          : `بازگشت وجه ثبت شد؛ ${formatTokens(r.tokensRemoved)} توکن کسر شد.`,
      );
      setShowRefund(false);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>جزئیات سفارش</h1>
        <button type="button" className="btn" onClick={() => navigate('/')}>
          بازگشت به نمای کلی
        </button>
      </div>
      <div className="section-gap">
        <ErrorBox message={error} />
        <OkBox message={ok} />
        <div className="grid-2">
          <Card title="اطلاعات سفارش">
            <dl className="kv">
              <dt>وضعیت</dt>
              <dd>
                <StatusBadge status={order.status} />{' '}
                {order.duplicateReceipt ? <span className="badge badge-warn">هشدار: رسید تکراری</span> : null}
              </dd>
              <dt>بسته</dt>
              <dd>{order.packTitle}</dd>
              <dt>توکن بسته</dt>
              <dd>{formatTokens(order.tokens)}</dd>
              <dt>مبلغ بسته</dt>
              <dd>{formatToman(order.priceRials)}</dd>
              <dt>مبلغ دریافتی</dt>
              <dd>{order.receivedAmountRials !== null ? formatToman(order.receivedAmountRials) : '—'}</dd>
              <dt>نام پرداخت‌کننده</dt>
              <dd>{order.payerName ?? '—'}</dd>
              <dt>۴ رقم آخر کارت</dt>
              <dd className="ltr mono">{order.cardLast4 ?? '—'}</dd>
              <dt>کد پیگیری</dt>
              <dd className="ltr mono">{order.reference ?? '—'}</dd>
              <dt>زمان پرداخت (متن کاربر)</dt>
              <dd>{order.paidAtText ?? '—'}</dd>
              <dt>تاریخ ثبت</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
              <dt>بررسی‌کننده</dt>
              <dd>
                {order.reviewedBy ?? '—'}
                {order.reviewedAt ? ` — ${formatDateTime(order.reviewedAt)}` : ''}
              </dd>
              {order.rejectReason ? (
                <>
                  <dt>دلیل رد</dt>
                  <dd>{order.rejectReason}</dd>
                </>
              ) : null}
              {order.adminNote ? (
                <>
                  <dt>یادداشت مدیر</dt>
                  <dd>{order.adminNote}</dd>
                </>
              ) : null}
            </dl>
          </Card>
          <Card title="کاربر">
            <dl className="kv">
              <dt>شماره موبایل</dt>
              <dd className="ltr mono">{user.phone}</dd>
              <dt>نام</dt>
              <dd>{user.name ?? '—'}</dd>
            </dl>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-sm" onClick={() => navigate(`/users/${user.id}`)}>
                مشاهده پرونده کاربر
              </button>
            </div>
          </Card>
        </div>

        <Card title="رسید پرداخت">
          {order.hasReceipt && !receiptError ? (
            <>
              {order.duplicateReceipt ? (
                <div className="alert alert-warn" style={{ marginBottom: 12 }}>
                  هشدار: تصویر این رسید قبلاً برای سفارش دیگری هم ارسال شده است. پیش از تأیید با دقت بررسی کنید.
                </div>
              ) : null}
              <img
                className="receipt-img"
                src={`/admin-api/orders/${encodeURIComponent(order.id)}/receipt`}
                alt="رسید پرداخت"
                onClick={() => setZoom(true)}
                onError={() => setReceiptError(true)}
              />
              <p className="small faint" style={{ marginTop: 8 }}>
                برای بزرگ‌نمایی روی تصویر کلیک کنید.
              </p>
            </>
          ) : (
            <p className="dim">برای این سفارش رسیدی ثبت نشده است.</p>
          )}
        </Card>

        {order.status === 'pending' && isOwner ? (
          <div className="grid-2">
            <Card title="تأیید سفارش">
              <div className="form-grid">
                <Field label="مبلغ دریافتی واقعی (تومان)">
                  <input className="input ltr" dir="ltr" inputMode="numeric" value={receivedToman} onChange={(e) => setReceivedToman(e.target.value)} />
                </Field>
                <Field label="یادداشت (اختیاری، حداکثر ۲۰۰ نویسه)">
                  <input className="input" maxLength={200} value={approveNote} onChange={(e) => setApproveNote(e.target.value)} />
                </Field>
                <button type="button" className="btn btn-primary" disabled={busy || Number.isNaN(tomanToRials(receivedToman))} onClick={() => void review('approve')}>
                  تأیید و اعطای توکن
                </button>
              </div>
            </Card>
            <Card title="رد سفارش">
              <div className="form-grid">
                <Field label="دلیل رد (به کاربر نمایش داده می‌شود)">
                  <input className="input" maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                </Field>
                <Field label="یادداشت داخلی (اختیاری، حداکثر ۲۰۰ نویسه)">
                  <input className="input" maxLength={200} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                </Field>
                <button type="button" className="btn btn-danger" disabled={busy || !rejectReason.trim()} onClick={() => void review('reject')}>
                  رد سفارش
                </button>
              </div>
            </Card>
          </div>
        ) : null}
        {order.status === 'pending' && !isOwner ? (
          <div className="alert alert-warn">تأیید یا رد سفارش فقط برای مالک پنل ممکن است.</div>
        ) : null}

        <Card
          title="بازگشت‌های وجه"
          actions={
            canRefund && order.status !== 'pending' && order.status !== 'rejected' ? (
              <button type="button" className="btn btn-sm" onClick={openRefund}>
                ثبت بازگشت وجه
              </button>
            ) : undefined
          }
        >
          {refunds.length === 0 ? (
            <p className="dim">بازگشت وجهی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>مبلغ</th>
                    <th>توکن کسرشده</th>
                    <th>دلیل</th>
                    <th>کد پیگیری</th>
                    <th>ثبت‌کننده</th>
                    <th>تاریخ</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr key={r.id}>
                      <td>{formatToman(r.amountRials)}</td>
                      <td>{formatTokens(r.tokensRemoved)}</td>
                      <td>{r.reason}</td>
                      <td className="ltr mono">{r.reference ?? '—'}</td>
                      <td className="ltr mono">{r.actor}</td>
                      <td className="small dim">{formatDateTime(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {zoom ? (
        <Modal title="رسید پرداخت" wide onClose={() => setZoom(false)}>
          <div className="receipt-zoom">
            <img src={`/admin-api/orders/${encodeURIComponent(order.id)}/receipt`} alt="رسید پرداخت (بزرگ)" onClick={() => setZoom(false)} />
          </div>
        </Modal>
      ) : null}

      {showRefund ? (
        <Modal title="ثبت بازگشت وجه" onClose={() => setShowRefund(false)}>
          <div className="form-grid">
            <Field label="مبلغ بازگشتی (تومان)">
              <input className="input ltr" dir="ltr" inputMode="numeric" value={refundToman} onChange={(e) => setRefundToman(e.target.value)} />
            </Field>
            <Field label="دلیل بازگشت">
              <input className="input" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
            </Field>
            <Field label="کد پیگیری (اختیاری)">
              <input className="input ltr" dir="ltr" value={refundRef} onChange={(e) => setRefundRef(e.target.value)} />
            </Field>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !refundReason.trim() || Number.isNaN(tomanToRials(refundToman)) || tomanToRials(refundToman) <= 0}
              onClick={() => void submitRefund()}
            >
              ثبت بازگشت وجه
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
