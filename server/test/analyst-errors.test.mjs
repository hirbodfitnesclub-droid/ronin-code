import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startStack, req, loginAdmin } from './helpers.mjs';

/**
 * Error-surface invariant (admin analyst chat): when the analyst gateway is
 * unreachable, the admin must see a human message only — the raw fetch cause
 * (ECONNREFUSED, "fetch failed", the internal URL) belongs in the server
 * log, never in the API response. Regression for the `${e.message}` suffix
 * that used to be embedded in the analyst_unreachable HttpError.
 */

let stack, owner, deadUrl;

before(async () => {
  // Reserve then release a port so the analyst URL is guaranteed dead.
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  deadUrl = `http://127.0.0.1:${port}`;

  stack = await startStack({ cfg: { analystBaseUrl: deadUrl, analystApiKey: 'test-analyst-key' } });
  owner = await loginAdmin(stack);
});

after(async () => {
  await stack.close();
});

test('analyst: unreachable gateway yields a human message with no raw cause text', async () => {
  const r = await req(stack.adminBase, '/admin-api/analyst/chat', {
    method: 'POST',
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { messages: [{ role: 'user', content: 'سلام' }] },
  });
  assert.equal(r.status, 502, r.text);
  assert.equal(r.json.error.code, 'analyst_unreachable');
  assert.equal(r.json.error.message, 'Analyst gateway unreachable.');
  assert.ok(!/fetch failed|ECONNREFUSED|127\.0\.0\.1|TypeError/i.test(r.text), r.text);
});
