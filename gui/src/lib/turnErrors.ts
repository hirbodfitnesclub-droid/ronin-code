/* Ronin Code — pure mapping from host turn_error codes to the chat
   banner (unit-tested, no React). Behaviour-only Phase 2 addition:
   the relay's `account_suspended` code joins `subscription_locked`
   on the existing locked banner, and the provider's 402 (surfaced by
   the host as `insufficient_credit`) stays on the existing credit
   banner. Transient key-provisioning (`provider_key_not_ready`) and
   every other code get NO banner — the generic turn message shows. */

export type TurnBanner = 'credit' | 'locked';

export function bannerForTurnError(code: string | undefined | null): TurnBanner | null {
  if (code === 'insufficient_credit') return 'credit';
  if (code === 'subscription_locked' || code === 'account_suspended') return 'locked';
  return null;
}
