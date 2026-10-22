import { useCallback, useEffect, useState } from 'react';
import { api, type AuditEntry } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Empty, ErrorBox, Field, Spinner, errText } from '../../components/ui/primitives';

const PAGE_SIZE = 50;

export default function AuditScreen() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [filters, setFilters] = useState({ actor: '', action: '' });
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.audit(filters.actor, filters.action, PAGE_SIZE, page * PAGE_SIZE);
      setRows(r.audit);
      setTotal(r.total);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div data-testid="screen-audit">
      <div className="page-head">
        <h1>گزارش ممیزی (Audit)</h1>
      </div>
      <form
        className="inline-form"
        style={{ marginBottom: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setFilters({ actor: actor.trim(), action: action.trim() });
        }}
      >
        <Field label="عامل (شماره موبایل)">
          <input className="input ltr" dir="ltr" value={actor} onChange={(e) => setActor(e.target.value)} />
        </Field>
        <Field label="عملیات">
          <input className="input ltr" dir="ltr" value={action} onChange={(e) => setAction(e.target.value)} placeholder="مثلاً order.review" />
        </Field>
        <button type="submit" className="btn btn-primary">
          پالایش
        </button>
      </form>
      <ErrorBox message={error} />
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty text="رکوردی یافت نشد." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>عامل</th>
                  <th>عملیات</th>
                  <th>هدف</th>
                  <th>جزئیات</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small dim">{formatDateTime(r.createdAt)}</td>
                    <td className="ltr mono small">{r.actor}</td>
                    <td className="ltr mono small">{r.action}</td>
                    <td className="mono small">{r.target ?? '—'}</td>
                    <td className="mono small" style={{ maxWidth: 340, overflowWrap: 'anywhere' }}>
                      {r.meta === null || r.meta === undefined ? '—' : JSON.stringify(r.meta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => setPage(page - 1)}>
              قبلی
            </button>
            <span className="dim small">
              صفحه {page + 1} از {pages} — مجموع {total} رکورد
            </span>
            <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              بعدی
            </button>
          </div>
        </>
      )}
    </div>
  );
}
