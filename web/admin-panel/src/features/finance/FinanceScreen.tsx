import { useCallback, useEffect, useState } from 'react';
import { api, hasCap, type Period, type Pnl, type Session } from '../../lib/api';
import { daysAgoIso, formatDate, formatToman, todayIso } from '../../lib/format';
import { BarChart, Card, ErrorBox, Field, Spinner, StatCard, errText } from '../../components/ui/primitives';
import { ExpensesPanel, PeriodsPanel } from './FinancePanels';

export default function FinanceScreen({ session }: { session: Session }) {
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());
  const [period, setPeriod] = useState<Period | null>(null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const canExpense = hasCap(session, 'expense_write');
  const canPolicy = hasCap(session, 'policy_write');
  const canExport = hasCap(session, 'export');

  const loadPnl = useCallback(async () => {
    setLoading(true);
    try {
      const params = period ? `periodId=${encodeURIComponent(period.id)}` : `from=${from}&to=${to}`;
      const r = await api.pnl(params);
      setPnl(r.pnl);
      if (r.period) setPeriod(r.period);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, period]);

  useEffect(() => {
    void loadPnl();
  }, [loadPnl]);

  const effFrom = pnl?.from ?? from;
  const effTo = pnl?.to ?? to;

  return (
    <div data-testid="screen-finance">
      <div className="page-head">
        <h1>مالی — سود و زیان</h1>
        {canExport ? (
          <a className="btn" href={`/admin-api/finance/export.csv?from=${effFrom}&to=${effTo}`}>
            دانلود خروجی CSV
          </a>
        ) : null}
      </div>
      <div className="section-gap">
        <Card title="بازه گزارش">
          <div className="inline-form">
            <Field label="از تاریخ">
              <input
                className="input ltr"
                dir="ltr"
                type="date"
                value={from}
                onChange={(e) => {
                  setPeriod(null);
                  setFrom(e.target.value);
                }}
              />
            </Field>
            <Field label="تا تاریخ">
              <input
                className="input ltr"
                dir="ltr"
                type="date"
                value={to}
                onChange={(e) => {
                  setPeriod(null);
                  setTo(e.target.value);
                }}
              />
            </Field>
            {period ? (
              <span className="badge badge-refunded">
                دوره: {period.title} ({formatDate(period.startsOn)} تا {formatDate(period.endsOn)})
              </span>
            ) : null}
          </div>
        </Card>
        <ErrorBox message={error} />
        {loading || !pnl ? (
          <Spinner />
        ) : (
          <>
            <div className="stat-grid">
              <StatCard label="درآمد" value={formatToman(pnl.incomeRials)} />
              <StatCard label="بازگشت وجه" value={formatToman(pnl.refundRials)} />
              <StatCard label="هزینه‌ها" value={formatToman(pnl.expenseRials)} />
              <StatCard label="سود / زیان خالص" value={formatToman(pnl.netRials)} />
            </div>
            <div className="grid-2">
              <Card title="درآمد و هزینه روزانه">
                <BarChart
                  data={pnl.daily.map((d) => ({ label: formatDate(d.date), value: Math.max(d.incomeRials, d.expenseRials) }))}
                  formatValue={(v) => formatToman(v)}
                />
                <p className="small faint">نمودار: بیشینهٔ درآمد و هزینهٔ هر روز. جزئیات در جدول دوره قابل بررسی است.</p>
              </Card>
              <Card title="هزینه‌ها به تفکیک دسته">
                {pnl.expensesByCategory.length === 0 ? (
                  <p className="dim">هزینه‌ای در این بازه ثبت نشده است.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data" style={{ minWidth: 0 }}>
                      <thead>
                        <tr>
                          <th>دسته</th>
                          <th>جمع</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pnl.expensesByCategory.map((c) => (
                          <tr key={c.category}>
                            <td>{c.category}</td>
                            <td>{formatToman(c.totalRials)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
        <ExpensesPanel from={effFrom} to={effTo} canWrite={canExpense} />
        <PeriodsPanel canWrite={canPolicy} onSelect={(p) => setPeriod(p)} />
      </div>
    </div>
  );
}
