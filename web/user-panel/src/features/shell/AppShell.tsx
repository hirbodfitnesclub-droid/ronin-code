import type { ReactNode } from 'react';
import { Logo } from '../../components/ui';
import { useLang, type StringKey } from '../../lib/i18n';
import type { View } from '../../lib/view';

const DESKTOP: Array<{ view: View; key: StringKey }> = [
  { view: 'dashboard', key: 'nav.dashboard' },
  { view: 'buy', key: 'nav.buy' },
  { view: 'purchases', key: 'nav.purchases' },
  { view: 'history', key: 'nav.history' },
  { view: 'devices', key: 'nav.devices' },
  { view: 'account', key: 'nav.account' },
];

/* Mobile bottom nav: 5 items — purchases is reached from dashboard + buy. */
const MOBILE: Array<{ view: View; key: StringKey; icon: string }> = [
  { view: 'dashboard', key: 'nav.dashboard', icon: '⌂' },
  { view: 'buy', key: 'nav.buy', icon: '+' },
  { view: 'history', key: 'nav.history', icon: '↺' },
  { view: 'devices', key: 'nav.devices', icon: '▣' },
  { view: 'account', key: 'nav.account', icon: '◉' },
];

export function AppShell({
  view,
  onNavigate,
  userName,
  children,
}: {
  view: View;
  onNavigate: (v: View) => void;
  userName: string;
  children: ReactNode;
}) {
  const { t, lang, setLang } = useLang();
  const initial = (userName.trim()[0] ?? 'R').toUpperCase();
  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-topbar-inner">
          <Logo />
          <nav className="shell-nav" aria-label="primary">
            {DESKTOP.map((item) => (
              <button
                key={item.view}
                type="button"
                className={view === item.view ? 'is-active' : undefined}
                onClick={() => onNavigate(item.view)}
              >
                {t(item.key)}
              </button>
            ))}
          </nav>
          <button type="button" className="lang-toggle" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>
            {lang === 'fa' ? 'EN' : 'فارسی'}
          </button>
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
        </div>
      </header>
      <main className="shell-main">{children}</main>
      <nav className="shell-bottomnav" aria-label="mobile">
        {MOBILE.map((item) => (
          <button
            key={item.view}
            type="button"
            className={view === item.view ? 'is-active' : undefined}
            onClick={() => onNavigate(item.view)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {t(item.key)}
          </button>
        ))}
      </nav>
    </div>
  );
}
