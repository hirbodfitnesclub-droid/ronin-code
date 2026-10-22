import { useCallback, useEffect, useState } from 'react';
import { Card, Chip, EmptyState, Spinner } from '../../components/ui';
import { api, isApiError, type Device } from '../../lib/api';
import { ERROR_CODE_KEYS, useLang, type LangCtx } from '../../lib/i18n';
import './devices.css';

function errorText(e: unknown, t: LangCtx['t']): string {
  if (isApiError(e)) {
    const key = ERROR_CODE_KEYS[e.code];
    if (key) return t(key);
    if (e.code === 'network') return t('errors.network');
  }
  return t('errors.unknown');
}

/** Tell the shell the session is gone so it can route back to login.
    api.logout()/logoutAll() already cleared the stored session
    (clients call clearSession() via setSession(null)). */
function notifySessionChanged() {
  window.dispatchEvent(new CustomEvent('ronin:session-changed'));
}

function DeviceIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    'aria-hidden': true,
  } as const;
  if (n.includes('iphone') || n.includes('android') || n.includes('ios') || n.includes('phone')) {
    return (
      <svg {...common}>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  if (n.includes('mac') || n.includes('laptop') || n.includes('book')) {
    return (
      <svg {...common}>
        <rect x="5" y="4" width="14" height="11" rx="1.5" />
        <path d="M2 19h20" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  );
}

function DeviceCard({ device, isCurrent, onRevoked }: { device: Device; isCurrent: boolean; onRevoked: () => void }) {
  const { t, fmtDate } = useLang();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const revoke = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.revokeDevice(device.id);
      onRevoked();
    } catch (e) {
      setErr(errorText(e, t));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Card>
      <div className="devices-head">
        <span className="devices-icon">
          <DeviceIcon name={device.name} />
        </span>
        <div className="devices-info">
          <div className="devices-name">
            {device.name}
            {isCurrent ? <Chip tone="accent">{t('devices.current')}</Chip> : null}
            {device.active ? <Chip tone="green">{t('dashboard.active')}</Chip> : <Chip>{t('dashboard.inactive')}</Chip>}
          </div>
          <div className="devices-meta">{t('devices.added', { date: fmtDate(device.createdAt) })}</div>
          {device.lastSeenAt ? (
            <div className="devices-meta">{t('devices.lastSeen', { date: fmtDate(device.lastSeenAt) })}</div>
          ) : null}
        </div>
      </div>
      {!isCurrent && device.active ? (
        <div className="devices-actions">
          {confirming ? (
            <>
              <span className="devices-confirm-text">{t('devices.revokeConfirm')}</span>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={revoke}>
                {busy ? t('devices.revoking') : t('common.confirm')}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-danger-outline" onClick={() => setConfirming(true)}>
              {t('devices.revoke')}
            </button>
          )}
          {err ? <span className="error-text">{err}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

/* Screen 6 — connected devices (max 2), per-device revoke, sign out all. */
export function DevicesScreen() {
  const { t } = useLang();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const [allErr, setAllErr] = useState<string | null>(null);
  const currentId = api.getSession()?.deviceId ?? null;

  const load = useCallback(() => {
    let alive = true;
    api
      .devices()
      .then((rows) => {
        if (!alive) return;
        setDevices(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e, t));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(load, [load]);

  const signOutAll = async () => {
    setBusyAll(true);
    setAllErr(null);
    try {
      await api.logoutAll();
    } catch (e) {
      // Clients clear the local session in a finally block; only treat it
      // as a failure when a session actually survives.
      if (api.getSession()) {
        setAllErr(errorText(e, t));
        setBusyAll(false);
        setConfirmAll(false);
        return;
      }
    }
    notifySessionChanged();
  };

  return (
    <div>
      <h1 className="page-title">{t('devices.title')}</h1>
      <p className="devices-note">{t('devices.limitNote')}</p>
      {devices === null && !error ? (
        <Card>
          <div className="devices-center">
            <Spinner />
            <span>{t('common.loading')}</span>
          </div>
        </Card>
      ) : error ? (
        <Card>
          <div className="devices-center">
            <span className="error-text">{error}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDevices(null);
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        </Card>
      ) : devices && devices.length === 0 ? (
        <Card>
          <EmptyState title={t('devices.title')} body={t('devices.empty')} />
        </Card>
      ) : (
        (devices ?? []).map((d) => (
          <DeviceCard key={d.id} device={d} isCurrent={d.id === currentId} onRevoked={() => setAttempt((n) => n + 1)} />
        ))
      )}
      <Card className="devices-danger">
        <div className="devices-danger-title">{t('devices.signOutAll')}</div>
        <div className="devices-danger-note">{t('account.dangerNote')}</div>
        {confirmAll ? (
          <div className="devices-actions">
            <button type="button" className="btn btn-danger" disabled={busyAll} onClick={signOutAll}>
              {t('common.confirm')}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busyAll} onClick={() => setConfirmAll(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmAll(true)}>
            {t('devices.signOutAll')}
          </button>
        )}
        {allErr ? (
          <div className="devices-actions">
            <span className="error-text">{allErr}</span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
