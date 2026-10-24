import type { ReactNode } from 'react';
import { useLang } from '../../lib/i18n';

/* Ronin Code — navigation rail (redesign shell). Sits at the
   inline-end edge (boards 01/08); collapsible to an icon rail.
   Every item is wired to a real view or action — no decoration. */

export type AppView = 'home' | 'workspace' | 'settings';

interface Props {
  view: AppView;
  settingsActive?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate: (view: 'home' | 'workspace') => void;
  onOpenSettings: () => void;
  onOpenIdea: () => void;
  onOpenStarters: () => void;
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function HomeIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M2.5 6.5 8 2l5.5 4.5" />
      <path d="M4 5.8V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.8" />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M9.5 2.5v11" />
    </svg>
  );
}

function IdeaIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M8 1.8a4.4 4.4 0 0 1 2.5 8.03c-.5.3-.8.7-.93 1.17H6.43a3.1 3.1 0 0 0-.93-1.17A4.4 4.4 0 0 1 8 1.8Z" />
      <path d="M6.3 13.4h3.4M7 15h2" />
    </svg>
  );
}

function StartersIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.34 1.34M11.06 11.06 12.4 12.4M12.4 3.6l-1.34 1.34M4.94 11.06 3.6 12.4" />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg {...iconProps} aria-hidden="true" style={collapsed ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

export default function NavRail(p: Props) {
  const { t } = useLang();
  const item = (
    key: string,
    label: string,
    icon: ReactNode,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className={`nav-item ${active ? 'nav-item--active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={p.collapsed ? label : undefined}
    >
      {icon}
      <span className="nav-item-label">{label}</span>
    </button>
  );

  return (
    <nav className={`nav-rail ${p.collapsed ? 'nav-rail--collapsed' : ''}`} aria-label="Ronin">
      {item('home', t('nav.home'), <HomeIcon />, p.view === 'home', () => p.onNavigate('home'))}
      {item('workspace', t('nav.workspace'), <WorkspaceIcon />, p.view === 'workspace', () => p.onNavigate('workspace'))}
      {item('idea', t('app.idea'), <IdeaIcon />, false, p.onOpenIdea)}
      {item('starters', t('starters.title'), <StartersIcon />, false, () => void p.onOpenStarters())}
      <div className="nav-spacer" />
      <div className="nav-rail-foot">
        {item('settings', t('app.settings'), <SettingsIcon />, Boolean(p.settingsActive), p.onOpenSettings)}
        <button
          type="button"
          className="nav-item"
          onClick={p.onToggleCollapsed}
          aria-label={p.collapsed ? t('nav.expand') : t('nav.collapse')}
          title={p.collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          <CollapseIcon collapsed={p.collapsed} />
          <span className="nav-item-label">{t('nav.collapse')}</span>
        </button>
      </div>
    </nav>
  );
}
