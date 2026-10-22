import type { Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import Logo from '../../components/ui/Logo';

/* Ronin Code — app header: brand, project actions, session cost,
   Auto/Plan toggles, mode badge, settings entry. */

interface Props {
  project: string;
  projectName: string;
  sessionCost: number;
  autoMode: boolean;
  planMode: boolean;
  mode: Mode;
  model?: string;
  onOpenProject: () => void;
  onOpenStarters: () => void;
  onOpenIdea: () => void;
  onOpenCheckpoints: () => void;
  onOpenPublish: () => void;
  onToggleAuto: () => void;
  onTogglePlan: () => void;
  onOpenSettings: () => void;
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
        <span className="wordmark-fa" lang="fa" dir="rtl">رونین کد</span>
      </div>

      <div className="header-project">
        {p.project ? (
          <span className="project-label">
            <span className="project-name">{p.projectName}</span>
            <span className="project-path" title={p.project} dir="ltr">{p.project}</span>
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
        {p.model && <span className="model-label" dir="ltr">{p.model}</span>}
        <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenSettings}>
          {t('app.settings')}
        </button>
      </div>
    </header>
  );
}
