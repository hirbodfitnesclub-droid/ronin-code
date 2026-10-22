import { useCallback, useEffect, useState } from 'react';
import { api, type Expense, type Period } from '../../lib/api';
import { formatDate, formatDateTime, formatToman, rialsToTomanInput, tomanToRials, todayIso } from '../../lib/format';
import { Card, ErrorBox, Field, Modal, OkBox, errText } from '../../components/ui/primitives';

export function ExpensesPanel({ from, to, canWrite }: { from: string; to: string; canWrite: boolean }) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [spentOn, setSpentOn] = useState(todayIso());

  const load = useCallback(async () => {
    try {
      setExpenses((await api.expenses(from, to)).expenses);
    } catch (e) {
      setError(errText(e));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setAmount('');
    setCategory('');
    setNote('');
    setSpentOn(todayIso());
    setShowForm(true);
  }

  function openEdit(x: Expense) {
    setEditing(x);
    setAmount(rialsToTomanInput(x.amountRials));
    setCategory(x.category);
    setNote(x.note ?? '');
    setSpentOn(x.spentOn);
    setShowForm(true);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { amountRials: tomanToRials(amount), category: category.trim(), note: note || undefined, spentOn };
      if (editing) await api.updateExpense(editing.id, body);
      else await api.createExpense(body);
      setOk(editing ? 'هزینه ویرایش شد.' : 'هزینه ثبت شد.');
      setShowForm(false);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(x: Expense) {
    if (!window.confirm(`هزینه «${x.category}» حذف شود؟`)) return;
    setBusy(true);
    try {
      await api.deleteExpense(x.id);
      setOk('هزینه حذف شد.');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="هزینه‌ها"
      actions={
        canWrite ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={openCreate}>
            ثبت هزینه جدید
          </button>
        ) : undefined
      }
    >
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {expenses.length === 0 ? (
        <p className="dim">در این بازه هزینه‌ای ثبت نشده است.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>مبلغ</th>
                <th>دسته</th>
                <th>توضیح</th>
                <th>تاریخ هزینه</th>
                <th>ثبت‌کننده</th>
                {canWrite ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {expenses.map((x) => (
                <tr key={x.id}>
                  <td>{formatToman(x.amountRials)}</td>
                  <td>{x.category}</td>
                  <td>{x.note ?? '—'}</td>
                  <td>{formatDate(x.spentOn)}</td>
                  <td className="ltr mono small">{x.actor}</td>
                  {canWrite ? (
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => openEdit(x)}>
                        ویرایش
                      </button>{' '}
                      <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove(x)}>
                        حذف
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showForm ? (
        <Modal title={editing ? 'ویرایش هزینه' : 'ثبت هزینه'} onClose={() => setShowForm(false)}>
          <div className="form-grid">
            <Field label="مبلغ (تومان)">
              <input className="input ltr" dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="دسته‌بندی">
              <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="مثلاً سرور، پیامک، تبلیغات" />
            </Field>
            <Field label="توضیح (اختیاری)">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field label="تاریخ هزینه">
              <input className="input ltr" dir="ltr" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
            </Field>
            <button type="button" className="btn btn-primary" disabled={busy || !category.trim() || Number.isNaN(tomanToRials(amount))} onClick={() => void save()}>
              ذخیره
            </button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

export function PeriodsPanel({ canWrite, onSelect }: { canWrite: boolean; onSelect: (p: Period) => void }) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [startsOn, setStartsOn] = useState(todayIso());
  const [endsOn, setEndsOn] = useState(todayIso());

  const load = useCallback(async () => {
    try {
      setPeriods((await api.periods()).periods);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError('');
    try {
      await api.createPeriod({ title: title.trim(), startsOn, endsOn });
      setTitle('');
      setOk('دوره مالی ساخته شد.');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function close(p: Period) {
    if (!window.confirm(`دوره «${p.title}» بسته شود؟`)) return;
    setBusy(true);
    try {
      await api.closePeriod(p.id);
      setOk('دوره بسته شد.');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="دوره‌های مالی">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {periods.length === 0 ? (
        <p className="dim">دوره‌ای تعریف نشده است.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: canWrite ? 16 : 0 }}>
          <table className="data">
            <thead>
              <tr>
                <th>عنوان</th>
                <th>از</th>
                <th>تا</th>
                <th>وضعیت</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}</td>
                  <td>{formatDate(p.startsOn)}</td>
                  <td>{formatDate(p.endsOn)}</td>
                  <td>{p.closedAt ? `بسته‌شده در ${formatDateTime(p.closedAt)}` : 'باز'}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => onSelect(p)}>
                      نمایش سود و زیان
                    </button>{' '}
                    {canWrite && !p.closedAt ? (
                      <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void close(p)}>
                        بستن دوره
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite ? (
        <div className="inline-form">
          <Field label="عنوان دوره">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً مهر ۱۴۰۵" />
          </Field>
          <Field label="از تاریخ">
            <input className="input ltr" dir="ltr" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="تا تاریخ">
            <input className="input ltr" dir="ltr" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => void create()}>
            ساخت دوره
          </button>
        </div>
      ) : null}
    </Card>
  );
}
