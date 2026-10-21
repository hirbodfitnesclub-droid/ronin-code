/**
 * Console provider for dev/tests: logs the message and records it in an
 * in-memory outbox so tests can read back OTP codes (like Liro's dev fallback
 * that printed codes to the server console when no key was configured).
 */
export function createConsoleProvider() {
  const outbox = [];
  async function sendTemplate(phone, template, tokens = []) {
    const entry = { phone, template, tokens: tokens.map(String), at: Date.now() };
    outbox.push(entry);
    console.log(`[sms:console] → ${phone} template=${template} tokens=${JSON.stringify(entry.tokens)}`);
    return { ok: true };
  }
  return { name: 'console', sendTemplate, outbox };
}
