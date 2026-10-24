import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { LanguageProvider } from './lib/i18n';
import type { View } from './lib/view';
import { panelEntryRoute } from './lib/view';
import { AppShell } from './features/shell/AppShell';
import { AuthScreen } from './features/auth/AuthScreen';
import { clearFromApp, detectFromApp } from './features/auth/helpers';
import { OnboardingScreen } from './features/onboarding/OnboardingScreen';
import { DashboardScreen } from './features/dashboard/DashboardScreen';
import { BuyScreen } from './features/buy/BuyScreen';
import { PurchasesScreen } from './features/purchases/PurchasesScreen';
import { HistoryScreen } from './features/history/HistoryScreen';
import { DevicesScreen } from './features/devices/DevicesScreen';
import { AccountScreen } from './features/account/AccountScreen';

const VIEWS: View[] = ['dashboard', 'buy', 'purchases', 'history', 'devices', 'account'];

/** Screens talk to the root through optional props when given, and through
    window events otherwise (logout / sign-out-all / cross-links). Both paths
    land here. Navigate event detail may be a View string or {view}. */
function Root() {
  const [view, setView] = useState<View>('dashboard');
  const [, setTick] = useState(0);
  const [fromApp] = useState<boolean>(detectFromApp);
  const [skipHandoff, setSkipHandoff] = useState(false);
  const session = api.getSession();

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const onSession = () => refresh();
    const onNavigate = (e: Event) => {
      const d = (e as CustomEvent<unknown>).detail;
      const v = typeof d === 'string' ? d : (d as { view?: unknown } | null)?.view;
      if (typeof v === 'string' && (VIEWS as string[]).includes(v)) setView(v as View);
    };
    window.addEventListener('ronin:session-changed', onSession);
    window.addEventListener('ronin:navigate', onNavigate);
    return () => {
      window.removeEventListener('ronin:session-changed', onSession);
      window.removeEventListener('ronin:navigate', onNavigate);
    };
  }, [refresh]);

  // Entry routing: an existing session that arrived from the desktop
  // app (?from=app) goes straight to the return-code screen — the
  // shell/onboarding must not swallow the handoff (panelEntryRoute).
  const entry = panelEntryRoute({
    hasSession: Boolean(session),
    onboarded: session?.user.onboarded === true,
    fromApp,
    skipHandoff,
  });

  if (entry === 'auth' || !session) return <AuthScreen onSessionChanged={refresh} />;

  if (entry === 'handoff') {
    return (
      <AuthScreen
        startWithHandoff
        onSessionChanged={refresh}
        onContinueToPanel={() => {
          clearFromApp();
          setSkipHandoff(true);
        }}
      />
    );
  }

  // First-login onboarding gate: one short screen until the profile's
  // onboarded flag flips (POST /api/me/onboarding updates the session user).
  if (entry === 'onboarding') return <OnboardingScreen onSessionChanged={refresh} />;

  return (
    <AppShell view={view} onNavigate={setView} userName={session.user.name ?? session.user.phone}>
      {view === 'dashboard' && <DashboardScreen onNavigate={setView} />}
      {view === 'buy' && <BuyScreen onNavigate={setView} />}
      {view === 'purchases' && <PurchasesScreen />}
      {view === 'history' && <HistoryScreen />}
      {view === 'devices' && <DevicesScreen />}
      {view === 'account' && <AccountScreen />}
    </AppShell>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <Root />
    </LanguageProvider>
  );
}
