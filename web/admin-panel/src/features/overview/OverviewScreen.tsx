import { useEffect, useState } from 'react';
import { api, type Order, type Overview } from '../../lib/api';
import { formatNumber, formatToman, formatTokens } from '../../lib/format';
import { ErrorBox, Spinner, StatCard, errText } from '../../components/ui/primitives';
import OrdersTable from '../orders/OrdersTable';

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'همه' },
  { key: 'pending', label: 'در انتظار بررسی' },
  { key: 'approved', label: 'تأییدشده' },
  { key: 'rejected', label: 'ردشده' },
  { key: 'refunded', label: 'بازگشت وجه' },
];

export default function OverviewScreen() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .overview()
      .then((o) => {
        if (alive) setOverview(o);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .orders(filter || undefined)
      .then((r) => {
        if (alive) setOrders(r.orders);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filter]);

  return (
    <div data-testid="screen-overview">
      <div className="page-head">
        <h1>نمای کلی</h1>
      </div>
      <ErrorBox message={error} />
      {overview ? (
        <div className="stat-grid">
          <StatCard label="کاربران" value={formatNumber(overview.users)} />
          <StatCard label="درآمد" value={formatToman(overview.revenueRials)} />
          <StatCard label="در انتظار بررسی" value={formatNumber(overview.pendingOrders)} />
          <StatCard label="توکن مصرف‌شده" value={formatTokens(overview.tokensConsumed)} />
          <StatCard label="توکن اعطاشده" value={formatTokens(overview.tokensGranted)} />
          <StatCard label="بازگشت وجه" value={formatToman(overview.refundedRials)} />
        </div>
      ) : (
        <Spinner />
      )}
      <section className="card">
        <div className="card-head">
          <h2>صف بررسی رسیدها</h2>
          <div className="tabs">
            {FILTERS.map((f) => (
              <button
                key={f.key || 'all'}
                type="button"
                className={`tab ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {loading ? <Spinner /> : <OrdersTable orders={orders} />}
      </section>
    </div>
  );
}
