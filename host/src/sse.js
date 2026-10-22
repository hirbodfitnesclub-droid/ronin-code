// Ronin Code — local host service.
// Server-sent events: the one broadcast channel from host to GUI.

export const sseClients = new Set();

export let eventSeq = 0;

export function broadcast(obj) {
  const evt = { id: ++eventSeq, ...obj };
  const data = `id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
  return evt;
}

// ---------- HTTP helpers ----------

export function addSseClient(res) { sseClients.add(res); }
export function removeSseClient(res) { sseClients.delete(res); }
export function bumpEventSeq() { return ++eventSeq; }
