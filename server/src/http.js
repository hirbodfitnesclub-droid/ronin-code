import { log } from './log.js';
import { HttpError } from './util.js';

/** Minimal HTTP plumbing shared by the user API and the standalone admin app. */

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

export function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new HttpError(413, 'body_too_large', 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

/** Tiny router: routes = [{method, pattern: '/api/orders/:id', handler}] */
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    async handle(req, res, ctx) {
      const url = new URL(req.url, 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      for (const r of routes) {
        if (r.method !== req.method || r.parts.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
          else if (r.parts[i] !== parts[i]) { ok = false; break; }
        }
        if (ok) return r.handler(req, res, { ...ctx, params, query: url.searchParams, url });
      }
      return null; // no route matched
    },
  };
}

export function withErrorHandling(handler) {
  return async (req, res, ctx) => {
    try {
      const out = await handler(req, res, ctx);
      if (out === null || out === undefined) {
        if (!res.writableEnded) sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
      }
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof HttpError) sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      else {
        log.error('unhandled_error', { error: e?.message ?? String(e) });
        sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error.' } });
      }
    }
  };
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
