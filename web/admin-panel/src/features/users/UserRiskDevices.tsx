import { useCallback, useEffect, useState } from 'react';
import { api, type Device, type RiskFlag } from '../../lib/api';
import { riskFlagDisplay } from '../../lib/providerKey';
import { formatDateTime } from '../../lib/format';
import { Card, ErrorBox, Field, OkBox, StatusBadge, errText } from '../../components/ui/primitives';

export default function UserRiskDevices({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [flags, setFlags] = useState<RiskFlag[]>([]);
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, f] = await Promise.all([api.userDevices(userId), api.userRiskFlags(userId)]);
      setDevices(d.devices);
      setFlags(f.flags);
    } catch (e) {
      setError(errText(e));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(deviceId: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api.revokeDevice(userId, deviceId);
      setDevices(r.devices);
      setOk('دستگاه لغو شد.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function createFlag() {
    setBusy(true);
    setError('');
    try {
      await api.createRiskFlag(userId, kind.trim(), note.trim());
      setKind('');
      setNote('');
      setOk('پرچم ریسک ثبت شد.');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolveFlag(flagId: string) {
    setBusy(true);
    setError('');
    try {
      await api.resolveRiskFlag(flagId);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="grid-2">
        <Card title="دستگاه‌های متصل">
          {devices.length === 0 ? (
            <p className="dim">دستگاهی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="data" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>نام</th>
                    <th>آخرین مشاهده</th>
                    <th>وضعیت</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td className="small dim">{formatDateTime(d.lastSeenAt)}</td>
                      <td>
                        <span className={`badge ${d.active ? 'badge-active' : 'badge-inactive'}`}>
                          {d.active ? 'فعال' : 'لغوشده'}
                        </span>
                      </td>
                      <td>
                        {d.active ? (
                          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revoke(d.id)}>
                            لغو دستگاه
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="پرچم‌های ریسک">
          {flags.length === 0 ? (
            <p className="dim">پرچم بازی وجود ندارد.</p>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table className="data" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>نوع</th>
                    <th>توضیح</th>
                    <th>وضعیت</th>
                    <th>تاریخ</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => {
                    const disp = riskFlagDisplay(f);
                    return (
                    <tr key={f.id}>
                      <td>
                        {disp.warn ? (
                          <span className="badge badge-warn">{disp.label}</span>
                        ) : (
                          disp.label
                        )}
                      </td>
                      <td>{disp.note}</td>
                      <td>
                        <StatusBadge status={f.status} />
                      </td>
                      <td className="small dim">{formatDateTime(f.createdAt)}</td>
                      <td>
                        {f.status === 'open' ? (
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resolveFlag(f.id)}>
                            بستن
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="form-grid">
            <div className="form-row">
              <Field label="نوع پرچم">
                <input className="input" value={kind} onChange={(e) => setKind(e.target.value)} placeholder="مثلاً multi_account" />
              </Field>
              <Field label="توضیح">
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            <button type="button" className="btn" disabled={busy || !kind.trim()} onClick={() => void createFlag()}>
              ثبت پرچم ریسک
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}
