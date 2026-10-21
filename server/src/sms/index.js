import { createKavenegarProvider } from './kavenegar.js';
import { createConsoleProvider } from './console.js';

/**
 * SMS service: one provider (Kavenegar in production, console in dev/tests) and
 * the four product notifications, mirroring Liro's template-driven approach:
 * pattern/template names come from env, never hard-coded.
 */
export function createSms(cfg) {
  const provider = cfg.smsProvider === 'kavenegar' ? createKavenegarProvider(cfg) : createConsoleProvider();
  const t = cfg.smsTemplates;
  const safe = async (fn) => {
    try { return await fn(); }
    catch (e) { console.error('[sms] send failed:', e.message); return { error: e.message }; }
  };
  return {
    provider,
    outbox: provider.outbox ?? null,
    /** OTP code — the template's %token% is the code itself (Liro semantics). */
    sendOtp: (phone, code) => safe(() => provider.sendTemplate(phone, t.otp || 'ronin-otp', [code])),
    /** Sent after an admin approves a card-to-card order: token=tokens granted, token2=pack title. */
    sendPackageActivated: (phone, tokens, packTitle) =>
      safe(() => provider.sendTemplate(phone, t.packageActivated, [tokens, packTitle])),
    /** Sent ~72h before a credit lot expires: token=days left, token2=tokens at risk. */
    sendExpiryWarning: (phone, daysLeft, tokens) =>
      safe(() => provider.sendTemplate(phone, t.expiryWarning, [daysLeft, tokens])),
    /** Sent when a credit lot expired: token=tokens expired. */
    sendExpired: (phone, tokens) => safe(() => provider.sendTemplate(phone, t.expired, [tokens])),
    /** Sent when an order is rejected: token=reason shown to the user. */
    sendOrderRejected: (phone, reason) => safe(() => provider.sendTemplate(phone, t.orderRejected, [reason])),
  };
}
