import { useEffect, useState } from 'react';
import { api, type AdminUser } from '../../lib/api';
import { formatDateTime, formatTokens } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Empty, ErrorBox, Spinner, errText } from '../../components/ui/primitives';

export default function UsersScreen() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .users(query)
      .then((r) => {
        if (alive) setUsers(r.users);
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
  }, [query]);

  return (
    <div data-testid="screen-users">
      <div className="page-head">
        <h1>کاربران</h1>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
          }}
        >
          <div className="field" style={{ minWidth: 260 }}>
            <input
              className="input"
              placeholder="جستجو با شماره موبایل یا نام…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">
            جستجو
          </button>
        </form>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <Spinner />
      ) : users.length === 0 ? (
        <Empty text="کاربری یافت نشد." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>موبایل</th>
                <th>نام</th>
                <th>وضعیت</th>
                <th>موجودی توکن</th>
                <th>تاریخ عضویت</th>
                <th>آخرین ورود</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="ltr mono">{u.phone}</td>
                  <td>{u.name ?? '—'}</td>
                  <td>
                    <span className={`badge ${u.isActive ? 'badge-active' : 'badge-inactive'}`}>
                      {u.isActive ? 'فعال' : 'غیرفعال'}
                    </span>
                  </td>
                  <td>{formatTokens(u.balanceTokens)}</td>
                  <td className="small dim">{formatDateTime(u.createdAt)}</td>
                  <td className="small dim">{formatDateTime(u.lastLoginAt)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => navigate(`/users/${u.id}`)}>
                      پرونده
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
