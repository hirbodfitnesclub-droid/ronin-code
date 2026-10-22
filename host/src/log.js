// Ronin Code — structured JSON-line logger (host).
//
// Hard rule: NEVER log secrets (API keys, tokens) or prompt/response
// content. Metadata only — ids, modes, counts, durations, and error
// messages that have already passed through util.cleanError (which
// redacts secret-looking values).

function emit(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, scope: "host", msg, ...(fields || {}) };
  const line = JSON.stringify(rec);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};
