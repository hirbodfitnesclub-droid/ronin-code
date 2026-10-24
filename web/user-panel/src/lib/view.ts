/* View routing — plain state, no router lib. */
export type View = 'dashboard' | 'buy' | 'purchases' | 'history' | 'devices' | 'account';

export type PanelEntry = 'auth' | 'handoff' | 'onboarding' | 'shell';

/**
 * Which screen the panel root shows on entry. The desktop-app handoff
 * outranks both onboarding and the shell: a user who arrived from the
 * app (?from=app) wants a return code, and an EXISTING panel session
 * must yield one immediately — before this decision existed in the
 * root, a signed-in user landed in the shell and no code was ever
 * offered (the app login dead-ended).
 */
export function panelEntryRoute(input: {
  hasSession: boolean;
  onboarded: boolean;
  fromApp: boolean;
  skipHandoff?: boolean;
}): PanelEntry {
  if (!input.hasSession) return 'auth';
  if (input.fromApp && !input.skipHandoff) return 'handoff';
  if (!input.onboarded) return 'onboarding';
  return 'shell';
}
