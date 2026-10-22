import { useCallback, useEffect, useState } from 'react';
import { api, hasCap, type LedgerEntry, type Lot, type Order, type Session } from '../../lib/api';
import { formatDate, formatDateTime, formatTokens } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Card, ErrorBox, Field, OkBox, Spinner, errText } from '../../components/ui/primitives';
import OrdersTable from '../orders/OrdersTable';
import UserRiskDevices from './UserRiskDevices';

interface Dossier {
  user: { id: string; phone: string; name: string | null; isActive: boolean; createdAt: number; lastLoginAt: number | null; onboarded: boolean; acquisitionSource: string | null; onboardingGoal: string | null };
  balanceTokens: number;
  ledger: LedgerEntry[];
  orders: Order[];
  lots: Lot[];
  openRiskFlags: number;
}

/* Onboarding chip keys (user panel) → FA labels for the dossier. */
const ACQUISITION_SOURCE_FA: Record<string, string> = {
  instagram: 'اینستاگرام',
  telegram: 'تلگرام',
  friend: 'معرفی دوستان',
  google: 'گوگل',
  youtube_aparat: 'یوتیوب / آپارات',
  other: 'سایر',
};
const ONBOARDING_GOAL_FA: Record<string, string> = {
  personal: 'سایت / اپ شخصی',
  freelance: 'کار فریلنسری',
  business: 'کسب‌وکار',
  learning: 'یادگیری',
  other: 'سایر',
};

export default function UserDetailScreen({ id, session }: { id: string; session: Session }) {
  const [data, setData] = useState<Dossier | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [adjustTokens, setAdjustTokens] = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const canFinance = hasCap(session, 'finance_user');
  const canRisk = hasCap(session, 'risk_manage');

  const load = useCallback(async () => {
    try {
      setData(await api.user(id));
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Spinner />;
  if (!data) return <ErrorBox message={error} />;
  const { user } = data;

  async function toggleActive() {
    setBusy(true);
    setError('');
    try {
      const r = await api.toggleUserActive(id, !user.isActive);
      setData({ ...data!, user: { ...user, isActive: r.isActive } });
      setOk(r.isActive ? 'کاربر فعال شد.' : 'کاربر غیرفعال شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function charge() {
    const tokens = Number(adjustTokens);
    if (!Number.isInteger(tokens) || tokens === 0 || adjustNote.trim().length < 3) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.chargeUser(id, tokens, adjustNote.trim());
      setOk(`تراکنش ثبت شد. موجودی جدید: ${formatTokens(r.balanceTokens)} توکن`);
      setAdjustTokens('');
      setAdjustNote('');
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
        <h1>پرونده کاربر</h1>
        <button type="button" className="btn" onClick={() => navigate('/users')}>
          بازگشت به فهرست کاربران
        </button>
      </div>
      <div className="section-gap">
        <ErrorBox message={error} />
        <OkBox message={ok} />
        <div className="grid-2">
          <Card title="هویت و وضعیت">
            <dl className="kv">
              <dt>شماره موبایل</dt>
              <dd className="ltr mono">{user.phone}</dd>
              <dt>نام</dt>
              <dd>{user.name ?? '—'}</dd>
              <dt>منبع آشنایی</dt>
              <dd>{user.acquisitionSource ? (ACQUISITION_SOURCE_FA[user.acquisitionSource] ?? user.acquisitionSource) : '—'}</dd>
              {user.onboardingGoal ? (
                <>
                  <dt>هدف استفاده</dt>
                  <dd>{ONBOARDING_GOAL_FA[user.onboardingGoal] ?? user.onboardingGoal}</dd>
                </>
              ) : null}
              <dt>وضعیت</dt>
              <dd>
                <span className={`badge ${user.isActive ? 'badge-active' : 'badge-inactive'}`}>
                  {user.isActive ? 'فعال' : 'غیرفعال'}
                </span>
              </dd>
              <dt>تاریخ عضویت</dt>
              <dd>{formatDateTime(user.createdAt)}</dd>
              <dt>آخرین ورود</dt>
              <dd>{formatDateTime(user.lastLoginAt)}</dd>
              <dt>پرچم ریسک باز</dt>
              <dd>{formatTokens(data.openRiskFlags)}</dd>
            </dl>
            {canRisk ? (
              <div style={{ marginTop: 14 }}>
                <button type="button" className={`btn ${user.isActive ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => void toggleActive()}>
                  {user.isActive ? 'غیرفعال‌کردن کاربر' : 'فعال‌کردن کاربر'}
                </button>
              </div>
            ) : null}
          </Card>
          <Card title="موجودی توکن">
            <div className="stat-value">{formatTokens(data.balanceTokens)}</div>
            <p className="small faint">موجودی فعلی از دفتر کل سرور خوانده می‌شود.</p>
            {canFinance ? (
              <div className="form-grid" style={{ marginTop: 16 }}>
                <div className="form-row">
                  <Field label="مقدار توکن (منفی = کسر)">
                    <input className="input ltr" dir="ltr" inputMode="numeric" value={adjustTokens} onChange={(e) => setAdjustTokens(e.target.value)} placeholder="1000000 یا ‎-500000‎" />
                  </Field>
                  <Field label="یادداشت (اجباری، حداقل ۳ نویسه)">
                    <input className="input" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} />
                  </Field>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !Number.isInteger(Number(adjustTokens)) || Number(adjustTokens) === 0 || adjustNote.trim().length < 3}
                  onClick={() => void charge()}
                >
                  ثبت تراکنش دستی
                </button>
              </div>
            ) : null}
          </Card>
        </div>

        <Card title="بسته‌های توکن (لات‌ها)">
          {data.lots.length === 0 ? (
            <p className="dim">لاتی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>منبع</th>
                    <th>کل توکن</th>
                    <th>باقی‌مانده</th>
                    <th>انقضا</th>
                    <th>تاریخ ایجاد</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lots.map((l) => (
                    <tr key={l.id}>
                      <td>{l.source}</td>
                      <td>{formatTokens(l.tokensTotal)}</td>
                      <td>{formatTokens(l.tokensLeft)}</td>
                      <td>{formatDate(l.expiresAt)}</td>
                      <td className="small dim">{formatDateTime(l.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="دفتر کل توکن">
          {data.ledger.length === 0 ? (
            <p className="dim">تراکنشی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>نوع</th>
                    <th>تغییر</th>
                    <th>مقدار</th>
                    <th>موجودی پس از آن</th>
                    <th>مرجع</th>
                    <th>یادداشت</th>
                    <th>تاریخ</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledger.map((e) => (
                    <tr key={e.id}>
                      <td>{e.kind}</td>
                      <td className={e.deltaTokens >= 0 ? 'pos' : 'neg'}>{formatTokens(e.deltaTokens)}</td>
                      <td>{formatTokens(e.amountTokens)}</td>
                      <td>{formatTokens(e.balanceAfter)}</td>
                      <td className="small mono">{e.refType ?? ''} {e.refId ?? ''}</td>
                      <td>{e.note ?? '—'}</td>
                      <td className="small dim">{formatDateTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="سفارش‌های کاربر">
          <OrdersTable orders={data.orders} />
        </Card>

        {canRisk ? <UserRiskDevices userId={id} /> : null}
      </div>
    </div>
  );
}
