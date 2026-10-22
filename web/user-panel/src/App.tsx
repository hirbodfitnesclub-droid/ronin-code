import { useCallback, useState } from 'react';
import { api } from './lib/api';
import { LanguageProvider } from './lib/i18n';
import type { View } from './lib/view';
import { AppShell } from './features/shell/AppShell';
import { AuthScreen } from './features/auth/AuthScreen';
import { DashboardScreen } from './features/dashboard/DashboardScreen';
import { BuyScreen } from './features/buy/BuyScreen';
import { PurchasesScreen } from './features/purchases/PurchasesScreen';
import { HistoryScreen } from './features/history/HistoryScreen';
import { DevicesScreen } from './features/devices/DevicesScreen';
import { AccountScreen } from './features/account/AccountScreen';

/* Composition root: providers + auth guard + view routing by state. */
function Root() {
  const [view, setView] = useState<View>('dashboard');
  const [, setTick] = useState(0);
  const session = api.getSession();

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  void refresh;

  if (!session) return <AuthScreen />;

  return (
    <AppShell view={view} onNavigate={setView} userName={session.user.name ?? session.user.phone}>
      {view === 'dashboard' && <DashboardScreen />}
      {view === 'buy' && <BuyScreen />}
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
