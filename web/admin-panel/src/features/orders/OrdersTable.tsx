import type { Order } from '../../lib/api';
import { formatDateTime, formatToman, formatTokens } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Empty, StatusBadge } from '../../components/ui/primitives';

export default function OrdersTable({ orders }: { orders: Order[] }) {
  if (orders.length === 0) return <Empty text="سفارشی برای نمایش نیست." />;
  return (
    <div className="table-wrap">
      <table className="data" data-testid="queue-table">
        <thead>
          <tr>
            <th>کاربر</th>
            <th>بسته</th>
            <th>توکن</th>
            <th>مبلغ</th>
            <th>وضعیت</th>
            <th>تاریخ ثبت</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>
                <span className="ltr mono">{o.userPhone}</span>
                {o.duplicateReceipt ? (
                  <>
                    {' '}
                    <span className="badge badge-warn">رسید تکراری؟</span>
                  </>
                ) : null}
              </td>
              <td>{o.packTitle}</td>
              <td>{formatTokens(o.tokens)}</td>
              <td>{formatToman(o.priceRials)}</td>
              <td>
                <StatusBadge status={o.status} />
              </td>
              <td className="small dim">{formatDateTime(o.createdAt)}</td>
              <td>
                <button type="button" className="btn btn-sm" onClick={() => navigate(`/orders/${o.id}`)}>
                  بررسی
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
