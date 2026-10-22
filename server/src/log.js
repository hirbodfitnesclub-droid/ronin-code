// Ronin Code — structured JSON-line logger (subscription server).
//
// Hard rule: NEVER log secrets (API keys, AUTH_SECRET, OTP codes,
// tokens, passwords) or message content. Metadata only — ids, counts,
// durations, error messages. (The dev-only console SMS provider is the
// single deliberate exception: it prints OTPs to the operator's console
// precisely so local development can read them; it never runs in
// production, where Kavenegar delivers the codes.)

function emit(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, scope: 'server', msg, ...(fields || {}) };
  const line = JSON.stringify(rec);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
