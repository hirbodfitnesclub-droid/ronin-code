import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack, req, lastOtpFor, loginUser, USER_PHONE } from './helpers.mjs';

/**
 * Host ↔ real-server seam coverage for the two app login FALLBACKS.
 *
 * Everywhere else, the host's auth flows are tested against stubs
 * (host unit tests mock fetch; host E2E runs against mock-ronin.mjs),
 * and the server's auth endpoints are tested without the host. The
 * seam itself — real host process, real server stack, real GoTrue —
 * had no coverage, which is how the login fallback could be broken
 * end-to-end while every suite stayed green. This test boots BOTH
 * real processes and drives the exact HTTP calls the GUI makes.
 *
 * The server runs production-shaped: no SUPABASE_JWT_SECRET, so
 * authenticate() takes the GoTrue /user fallback path like Vercel.
 * SMS is the console transport (the provider boundary) — a real SMS
 * stays the owner's test.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_ENTRY = path.join(REPO_ROOT, 'host', 'src', 'server.js');

let stack;
let hostProc;
let hostHome;
let hostBase;
let hostToken;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const hreq = (path, opts = {}) =>
  req(hostBase, path, { ...opts, headers: { 'X-Ronin-Token': hostToken, ...(opts.headers ?? {}) } });

before(async () => {
  stack = await startStack({ cfg: { supabaseJwtSecret: '' } });
  const port = await freePort();
  hostBase = `http://127.0.0.1:${port}`;
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ronin-host-it-'));
  hostProc = spawn('node', [HOST_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RONIN_HOME: hostHome,
      RONIN_SERVER_URL: stack.base,
      RONIN_PANEL_URL: stack.base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostProc.stderr.on('data', (d) => process.stderr.write(`[host-it] ${d}`));
  // The GUI reads the per-boot API token from /ronin-config.js.
  for (let i = 0; i < 75 && !hostToken; i++) {
    try {
      const js = await (await fetch(`${hostBase}/ronin-config.js`)).text();
      hostToken = js.match(/"([0-9a-f]{48})"/)?.[1] ?? null;
    } catch { /* not up yet */ }
    if (!hostToken) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(hostToken, 'host did not come up with an API token');
});

after(async () => {
  hostProc?.kill('SIGTERM');
  await stack?.close();
  if (hostHome) fs.rmSync(hostHome, { recursive: true, force: true });
});

test('fallback (b): in-app OTP — request + verify through the real host logs the app in', async () => {
  const r1 = await hreq('/api/auth/otp/request', { method: 'POST', body: { phone: USER_PHONE } });
  assert.equal(r1.status, 200, `otp request via host: ${r1.text}`);
  const code = lastOtpFor(stack.sms, USER_PHONE); // console transport = provider boundary
  const r2 = await hreq('/api/auth/otp/verify', { method: 'POST', body: { phone: USER_PHONE, code } });
  assert.equal(r2.status, 200, `otp verify via host: ${r2.text}`);
  assert.equal(r2.json?.user?.phone, USER_PHONE);
  const st = await hreq('/api/auth/state');
  assert.equal(st.json?.loggedIn, true, 'host must hold a session after in-app OTP');
  const out = await hreq('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(out.status, 200);
  const st2 = await hreq('/api/auth/state');
  assert.equal(st2.json?.loggedIn, false);
});

test('fallback (a): manual return code — panel session mints, host exchanges, code is single-use', async () => {
  const panel = await loginUser(stack, USER_PHONE); // the web-panel session
  const issued = await req(stack.base, '/api/auth/handoff', { method: 'POST', token: panel.accessToken, body: {} });
  assert.equal(issued.status, 200, `handoff issue: ${issued.text}`);
  assert.ok(issued.json?.code, 'a return code must be issued to a signed-in panel user');

  const ex = await hreq('/api/auth/exchange-code', { method: 'POST', body: { code: issued.json.code } });
  assert.equal(ex.status, 200, `exchange via host: ${ex.text}`);
  assert.equal(ex.json?.user?.phone, USER_PHONE);
  const st = await hreq('/api/auth/state');
  assert.equal(st.json?.loggedIn, true, 'host must hold a session after code exchange');

  const again = await hreq('/api/auth/exchange-code', { method: 'POST', body: { code: issued.json.code } });
  assert.notEqual(again.status, 200, 'the same code must not exchange twice');
  assert.equal(again.json?.error, 'code_used');
});
