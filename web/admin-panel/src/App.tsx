import { useEffect, useState } from 'react';
import { api, hasCap, setCsrf, type Session } from './lib/api';
import { navigate, useHashRoute } from './lib/router';
import { Spinner } from './components/ui/primitives';
import LoginScreen from './features/auth/LoginScreen';
import OverviewScreen from './features/overview/OverviewScreen';
import OrderDetailScreen from './features/orders/OrderDetailScreen';
import UsersScreen from './features/users/UsersScreen';
import UserDetailScreen from './features/users/UserDetailScreen';
import FinanceScreen from './features/finance/FinanceScreen';
import AnalyticsScreen from './features/analytics/AnalyticsScreen';
import SettingsScreen from './features/settings/SettingsScreen';
import AuditScreen from './features/audit/AuditScreen';

interface NavItem {
  key: string;
  label: string;
  to: string;
  testid: string;
  visible: boolean;
  active: string[];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const route = useHashRoute();

  useEffect(() => {
    api
      .session()
      .then((s) => {
        setCsrf(s.csrfToken);
        setSession(s);
      })
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Spinner />;
  if (!session) {
    return (
      <LoginScreen
        onLogin={(s) => {
          setSession(s);
          navigate('/');
        }}
      />
    );
  }

  const nav: NavItem[] = [
    { key: 'overview', label: 'نمای کلی', to: '/', testid: 'nav-overview', visible: hasCap(session, 'finance_view'), active: ['overview', 'order'] },
    { key: 'users', label: 'کاربران', to: '/users', testid: 'nav-users', visible: hasCap(session, 'finance_user'), active: ['users', 'user'] },
    { key: 'finance', label: 'مالی', to: '/finance', testid: 'nav-finance', visible: hasCap(session, 'finance_view'), active: ['finance'] },
    { key: 'analytics', label: 'تحلیل و آمار', to: '/analytics', testid: 'nav-analytics', visible: hasCap(session, 'finance_view'), active: ['analytics'] },
    { key: 'settings', label: 'تنظیمات', to: '/settings', testid: 'nav-settings', visible: hasCap(session, 'policy_write'), active: ['settings'] },
    { key: 'audit', label: 'ممیزی', to: '/audit', testid: 'nav-audit', visible: session.role === 'owner', active: ['audit'] },
  ];
  const firstVisible = nav.find((n) => n.visible);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Session may already be gone server-side; clear locally regardless.
    }
    setCsrf('');
    setSession(null);
    navigate('/');
  }

  function renderScreen() {
    switch (route.name) {
      case 'order':
        return route.param ? <OrderDetailScreen id={route.param} session={session!} /> : null;
      case 'users':
        return hasCap(session, 'finance_user') ? <UsersScreen /> : <Forbidden />;
      case 'user':
        return route.param && hasCap(session, 'finance_user') ? (
          <UserDetailScreen id={route.param} session={session!} />
        ) : (
          <Forbidden />
        );
      case 'finance':
        return hasCap(session, 'finance_view') ? <FinanceScreen session={session!} /> : <Forbidden />;
      case 'analytics':
        return hasCap(session, 'finance_view') ? <AnalyticsScreen /> : <Forbidden />;
      case 'settings':
        return hasCap(session, 'policy_write') ? <SettingsScreen session={session!} /> : <Forbidden />;
      case 'audit':
        return session!.role === 'owner' ? <AuditScreen /> : <Forbidden />;
      default:
        if (hasCap(session, 'finance_view')) return <OverviewScreen />;
        if (firstVisible) {
          navigate(firstVisible.to);
          return <Spinner />;
        }
        return <Forbidden />;
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">رونین کد</div>
            <div className="brand-sub">پنل مدیریت</div>
          </div>
        </div>
        {nav
          .filter((n) => n.visible)
          .map((n) => (
            <button
              key={n.key}
              type="button"
              data-testid={n.testid}
              className={`nav-item ${n.active.includes(route.name) ? 'active' : ''}`}
              onClick={() => navigate(n.to)}
            >
              <span className="nav-label">{n.label}</span>
            </button>
          ))}
        <div className="nav-spacer" />
        <div className="session-box">
          <div className="session-meta">
            <div className="ltr mono small">{session.phone}</div>
            <div className="small faint">{session.role === 'owner' ? 'مالک' : 'همکار مالی'}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => void logout()}>
            خروج
          </button>
        </div>
      </aside>
      <main className="main">{renderScreen()}</main>
    </div>
  );
}

function Forbidden() {
  return (
    <div className="alert alert-warn" style={{ marginTop: 30 }}>
      برای مشاهده این بخش دسترسی لازم را ندارید.
    </div>
  );
}
