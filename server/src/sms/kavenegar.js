import { log } from '../log.js';
/**
 * Kavenegar Verify Lookup provider (the only real SMS provider — Liro parity).
 * POST https://api.kavenegar.com/v1/{API_KEY}/verify/lookup.json
 * form-encoded: receptor, template, token (+ token2/token3 for multi-placeholder patterns).
 * The API key lives in the URL path per Kavenegar's scheme and is NEVER logged.
 */
export function createKavenegarProvider(cfg) {
  async function sendTemplate(phone, template, tokens = []) {
    if (!cfg.kavenegarApiKey) throw new Error('KAVENEGAR_API_KEY is not configured');
    if (!template) return { skipped: true, reason: 'no_template_configured' };
    if (cfg.smsAllowlist.length && !cfg.smsAllowlist.includes(phone)) {
      log.info('sms_allowlist_skip', { phone });
      return { skipped: true, reason: 'not_in_allowlist' };
    }
    const form = new URLSearchParams({ receptor: phone, template });
    if (tokens[0] !== undefined) form.set('token', String(tokens[0]));
    if (tokens[1] !== undefined) form.set('token2', String(tokens[1]));
    if (tokens[2] !== undefined) form.set('token3', String(tokens[2]));
    const url = `https://api.kavenegar.com/v1/${encodeURIComponent(cfg.kavenegarApiKey)}/verify/lookup.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => null);
    const status = data?.return?.status;
    if (!res.ok || (status !== undefined && status !== 200)) {
      throw new Error(`Kavenegar send failed (http ${res.status}, status ${status ?? 'n/a'})`);
    }
    return { ok: true };
  }
  return { name: 'kavenegar', sendTemplate };
}
