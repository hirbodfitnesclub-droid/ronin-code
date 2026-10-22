import { useEffect, useRef, useState } from 'react';
import { api, type AuthState, type Mode } from '../../lib/api';
import { formatTokens } from '../../lib/format';
import { useLang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';

/* Ronin Code — app header: brand, project actions, session cost,
   Auto/Plan toggles, mode badge, account chip, settings entry. */

interface Props {
  project: string;
  projectName: string;
  sessionCost: number;
  autoMode: boolean;
  planMode: boolean;
  mode: Mode;
  model?: string;
  auth?: AuthState;
  panelUrl?: string;
  onStatusRefresh: () => void;
  onOpenProject: () => void;
  onOpenStarters: () => void;
  onOpenIdea: () => void;
  onOpenCheckpoints: () => void;
  onOpenPublish: () => void;
  onToggleAuto: () => void;
  onTogglePlan: () => void;
  onOpenSettings: () => void;
}

function AccountChip({ auth, panelUrl, onStatusRefresh }: { auth: AuthState; panelUrl: string; onStatusRefresh: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open ]);

  const user = auth.user;
  const sub = auth.subscription;
  const displayName = user?.name || user?.phone || '';
  const initial = (displayName.trim().charAt(0) || 'R').toUpperCase();
  const balance = sub ? formatTokens(sub.spendableTokens ?? sub.balanceTokens) : null;

  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshStatus();
    } catch {
      /* the status refresh below still re-reads the host state */
    } finally {
      setBusy(false);
      setOpen(false);
      onStatusRefresh();
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      /* still re-read status — the gate decides what shows next */
    } finally {
      setBusy(false);
      setOpen(false);
      onStatusRefresh();
    }
  };

  return (
    <div className="account-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className="account-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="account-avatar" aria-hidden="true">
          {initial}
          {sub?.stale && <span className="account-stale-dot" />}
        </span>
        <span className="account-chip-text">
          <span className="account-name">{displayName}</span>
          {balance !== null && (
            <span className="account-balance" dir="ltr">
              {balance} {t('account.tokens')}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">
            <span className="account-name">{displayName}</span>
            {balance !== null && (
              <span className="account-menu-balance" dir="ltr">
                {t('account.balance')}: {balance}
              </span>
            )}
          </div>
          <button
            type="button"
            className="account-menu-item"
            role="menuitem"
            onClick={() => {
              if (panelUrl) window.open(panelUrl, '_blank', 'noopener');
              setOpen(false);
            }}
          >
            {t('account.openPanel')}
          </button>
          <button type="button" className="account-menu-item" role="menuitem" onClick={() => void refresh()} disabled={busy}>
            {t('account.refreshBalance')}
          </button>
          <button type="button" className="account-menu-item" role="menuitem" onClick={() => void logout()} disabled={busy}>
            {t('account.logout')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Header(p: Props) {
  const { t, fmtUsd } = useLang();
  return (
    <header className="header">
      <div className="brand">
        <Logo />
        <span className="wordmark">
          Ronin <span className="wordmark-accent">Code</span>
        </span>
        <span className="wordmark-fa" lang="fa" dir="rtl">
          رونین کد
        </span>
      </div>

      <div className="header-project">
        {p.project ? (
          <span className="project-label">
            <span className="project-name">{p.projectName}</span>
            <span className="project-path" title={p.project} dir="ltr">
              {p.project}
            </span>
          </span>
        ) : (
          <span className="project-path project-path--empty">{t('app.noProjectYet')}</span>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenProject}>
          {t('app.openProject')}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void p.onOpenStarters()}>
          {t('app.createStarter')}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenIdea}>
          {t('app.idea')}
        </button>
        {p.project && (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenCheckpoints}>
              {t('app.checkpoints')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenPublish}>
              {t('app.publish')}
            </button>
          </>
        )}
      </div>

      <div className="header-right">
        {p.sessionCost > 0 && (
          <span className="cost-chip" dir="ltr" title={t('cost.session')}>
            {t('cost.session')} <b>{fmtUsd(p.sessionCost)}</b>
          </span>
        )}
        <button
          type="button"
          className={`toggle-pill ${p.autoMode ? 'toggle-pill--on' : ''}`}
          onClick={() => void p.onToggleAuto()}
          title={p.autoMode ? t('app.autoOn') : t('app.autoOff')}
          aria-pressed={p.autoMode}
        >
          <span className="toggle-dot" />
          {t('app.auto')}
        </button>
        <button
          type="button"
          className={`toggle-pill toggle-pill--plan ${p.planMode ? 'toggle-pill--on' : ''}`}
          onClick={() => void p.onTogglePlan()}
          title={p.planMode ? t('app.planOn') : t('app.planOff')}
          aria-pressed={p.planMode}
        >
          <span className="toggle-dot" />
          {t('app.plan')}
        </button>
        <span className={`mode-badge ${p.mode === 'live' ? 'mode-badge--live' : 'mode-badge--preview'}`}>
          <span className="mode-dot" />
          {p.mode === 'live' ? t('app.live') : t('app.previewMode')}
        </span>
        {p.model && (
          <span className="model-label" dir="ltr">
            {p.model}
          </span>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenSettings}>
          {t('app.settings')}
        </button>
        {p.auth?.loggedIn && (
          <AccountChip auth={p.auth} panelUrl={p.panelUrl ?? ''} onStatusRefresh={p.onStatusRefresh} />
        )}
      </div>
    </header>
  );
}
