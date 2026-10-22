import { useState } from 'react';
import { api, type ModelConfig, type Pack, type Settings } from '../../lib/api';
import { rialsToTomanInput, tomanToRials } from '../../lib/format';
import { Card, ErrorBox, Field, OkBox, errText } from '../../components/ui/primitives';

export const ALL_CAPS = ['finance_view', 'finance_user', 'risk_manage', 'expense_write', 'refund_write', 'policy_write', 'export'];

export function PacksEditor({ initial, canWrite }: { initial: Pack[]; canWrite: boolean }) {
  const [packs, setPacks] = useState<Pack[]>(initial);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  function patch(i: number, p: Partial<Pack>) {
    setPacks(packs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.savePacks(
        packs.map((p) => ({
          id: p.id,
          title: p.title,
          usd: p.usd ?? 0,
          priceRials: p.priceRials,
          validityDays: p.validityDays,
          badge: p.badge || null,
          note: p.note || null,
        })) as Pack[],
      );
      setOk('بسته‌ها ذخیره شدند.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="بسته‌های فروش (حداکثر ۸ بسته)">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="form-grid">
        {packs.map((p, i) => (
          <div className="editor-row" key={p.id || i}>
            <div className="form-row">
              <Field label="شناسه بسته">
                <input className="input ltr" dir="ltr" disabled={!canWrite} value={p.id} onChange={(e) => patch(i, { id: e.target.value })} />
              </Field>
              <Field label="عنوان">
                <input className="input" disabled={!canWrite} value={p.title} onChange={(e) => patch(i, { title: e.target.value })} />
              </Field>
              <Field label="قیمت (تومان)">
                <input
                  className="input ltr"
                  dir="ltr"
                  inputMode="numeric"
                  disabled={!canWrite}
                  value={rialsToTomanInput(p.priceRials)}
                  onChange={(e) => patch(i, { priceRials: tomanToRials(e.target.value) })}
                />
              </Field>
              <Field label="اعتبار (روز)">
                <input className="input ltr" dir="ltr" inputMode="numeric" disabled={!canWrite} value={p.validityDays} onChange={(e) => patch(i, { validityDays: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="برچسب (اختیاری)">
                <input className="input" disabled={!canWrite} value={p.badge ?? ''} onChange={(e) => patch(i, { badge: e.target.value || null })} />
              </Field>
              <Field label="یادداشت (اختیاری)">
                <input className="input" disabled={!canWrite} value={p.note ?? ''} onChange={(e) => patch(i, { note: e.target.value || null })} />
              </Field>
              <Field label="دلار مبنا">
                <input className="input ltr" dir="ltr" inputMode="decimal" disabled={!canWrite} value={p.usd ?? ''} onChange={(e) => patch(i, { usd: Number(e.target.value) })} />
              </Field>
            </div>
            {canWrite ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setPacks(packs.filter((_, j) => j !== i))}>
                حذف بسته
              </button>
            ) : null}
          </div>
        ))}
        {canWrite ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={packs.length >= 8}
              onClick={() => setPacks([...packs, { id: '', title: '', usd: 0, priceRials: 0, validityDays: 30, badge: null, note: null }])}
            >
              افزودن بسته
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              ذخیره بسته‌ها
            </button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function ModelsEditor({ initial, canWrite }: { initial: ModelConfig[]; canWrite: boolean }) {
  const [models, setModels] = useState<ModelConfig[]>(initial);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  function patch(i: number, p: Partial<ModelConfig>) {
    setModels(models.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.saveModels(models);
      setOk('مدل‌ها ذخیره شدند.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="مدل‌ها و ضریب مصرف">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="form-grid">
        {models.map((m, i) => (
          <div className="editor-row" key={`${m.model}-${i}`}>
            <div className="form-row">
              <Field label="نام مدل">
                <input className="input ltr" dir="ltr" disabled={!canWrite} value={m.model} onChange={(e) => patch(i, { model: e.target.value })} />
              </Field>
              <Field label="ضریب">
                <input className="input ltr" dir="ltr" inputMode="decimal" disabled={!canWrite} value={m.multiplier} onChange={(e) => patch(i, { multiplier: Number(e.target.value) })} />
              </Field>
              <Field label="فعال">
                <label className="check" style={{ paddingTop: 8 }}>
                  <input type="checkbox" disabled={!canWrite} checked={m.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                  فعال است
                </label>
              </Field>
            </div>
            {canWrite ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setModels(models.filter((_, j) => j !== i))}>
                حذف مدل
              </button>
            ) : null}
          </div>
        ))}
        {canWrite ? (
          <>
            <button type="button" className="btn" onClick={() => setModels([...models, { model: '', multiplier: 1, enabled: true }])}>
              افزودن مدل
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              ذخیره مدل‌ها
            </button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function StaffEditor({ initial }: { initial: NonNullable<Settings['financeStaff']> }) {
  const [staff, setStaff] = useState(initial);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleCap(i: number, cap: string) {
    setStaff(
      staff.map((s, j) =>
        j === i ? { ...s, caps: s.caps.includes(cap) ? s.caps.filter((c) => c !== cap) : [...s.caps, cap] } : s,
      ),
    );
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.saveFinanceStaff(staff.filter((s) => s.phone.trim()));
      setOk('فهرست همکاران مالی ذخیره شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="همکاران مالی (فقط مالک)">
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="form-grid">
        {staff.map((s, i) => (
          <div className="editor-row" key={i}>
            <Field label="شماره موبایل همکار">
              <input
                className="input ltr"
                dir="ltr"
                value={s.phone}
                onChange={(e) => setStaff(staff.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {ALL_CAPS.map((cap) => (
                <label className="check" key={cap}>
                  <input type="checkbox" checked={s.caps.includes(cap)} onChange={() => toggleCap(i, cap)} />
                  <span className="ltr mono small">{cap}</span>
                </label>
              ))}
            </div>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setStaff(staff.filter((_, j) => j !== i))}>
              حذف همکار
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setStaff([...staff, { phone: '', caps: [] }])}>
          افزودن همکار
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          ذخیره همکاران
        </button>
      </div>
    </Card>
  );
}
