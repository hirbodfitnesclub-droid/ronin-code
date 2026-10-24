import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveApiClient } from '../src/lib/api/live.ts';
import { saveSession, loadSession } from '../src/lib/api/session.ts';
import type { Session } from '../src/lib/api/types.ts';

/* Refresh-race regression: the server revokes the whole device session
   when a rotated refresh token is presented twice (theft detection in
   refreshSession, server/src/auth.js). The dashboard fires several API
   calls in parallel; with an expired access token they all 401 at once,
   and the client used to fire one /api/auth/refresh per caller — the
   second one presented the just-rotated token and nuked the session.
   The client must share ONE in-flight refresh no matter how many
   callers pile up. The stub below models the server faithfully: a
   refresh token is single-use; presenting a rotated one is a 401
   'refresh_reuse' and (like the server) kills the session. */

const USER = {
  id: 'u1',
  phone: '09121111111',
  name: null,
  isActive: true,
  createdAt: '2026-10-24T00:00:00.000Z',
  onboarded: true,
  acquisitionSource: null,
  onboardingGoal: null,
};

function stubStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

function stubRotatingServer() {
  const state = { validRefresh: 'rt-1', refreshCalls: 0, reuseSeen: false };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const path = String(url);
    if (path.includes('/api/auth/refresh')) {
      state.refreshCalls++;
      const body = JSON.parse(init?.body ?? '{}') as { refreshToken?: string };
      if (body.refreshToken !== state.validRefresh) {
        state.reuseSeen = true; // server would revoke the device here
        return { status: 401, ok: false, json: async () => ({ error: { code: 'refresh_reuse', message: 'reuse' } }) };
      }
      const n = state.refreshCalls + 1;
      state.validRefresh = `rt-${n}`;
      return {
        status: 200,
        ok: true,
        json: async () => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}` }),
      };
    }
    const auth = init?.headers?.Authorization ?? '';
    if (auth === 'Bearer at-1') {
      return { status: 401, ok: false, json: async () => ({ error: { code: 'token_expired', message: 'expired' } }) };
    }
    if (auth.startsWith('Bearer at-')) {
      return { status: 200, ok: true, json: async () => ({ status: 'active', isActive: true }) };
    }
    return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found', message: 'nf' } }) };
  };
  return state;
}

test('parallel 401s share ONE refresh; the rotated token is never re-presented', async () => {
  stubStorage();
  const server = stubRotatingServer();
  const session: Session = { accessToken: 'at-1', refreshToken: 'rt-1', deviceId: 'd1', user: USER };
  saveSession(session);
  const client = new LiveApiClient();

  const results = await Promise.all([
    client.accountStatus(),
    client.accountStatus(),
    client.accountStatus(),
  ]);

  assert.equal(server.refreshCalls, 1, 'exactly one refresh may reach the wire');
  assert.equal(server.reuseSeen, false, 'rotated token must never be presented twice');
  assert.ok(results.every((r) => r.status === 'active'), 'all callers recover with the new token');
  assert.equal(loadSession()?.accessToken, 'at-2');
  assert.equal(loadSession()?.refreshToken, 'rt-2');
});

test('the in-flight slot resets: a later expiry refreshes again (exactly once)', async () => {
  stubStorage();
  const expired = new Set(['at-1']);
  const state = { validRefresh: 'rt-1', refreshCalls: 0, reuseSeen: false };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const path = String(url);
    if (path.includes('/api/auth/refresh')) {
      state.refreshCalls++;
      const body = JSON.parse(init?.body ?? '{}') as { refreshToken?: string };
      if (body.refreshToken !== state.validRefresh) {
        state.reuseSeen = true;
        return { status: 401, ok: false, json: async () => ({ error: { code: 'refresh_reuse', message: 'reuse' } }) };
      }
      const n = state.refreshCalls + 1;
      state.validRefresh = `rt-${n}`;
      return { status: 200, ok: true, json: async () => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}` }) };
    }
    const auth = init?.headers?.Authorization ?? '';
    if (auth.startsWith('Bearer at-') && !expired.has(auth.slice('Bearer '.length))) {
      return { status: 200, ok: true, json: async () => ({ status: 'active', isActive: true }) };
    }
    return { status: 401, ok: false, json: async () => ({ error: { code: 'token_expired', message: 'expired' } }) };
  };
  saveSession({ accessToken: 'at-1', refreshToken: 'rt-1', deviceId: 'd1', user: USER });
  const client = new LiveApiClient();

  const r1 = await client.accountStatus(); // at-1 expired → refresh #1 → at-2 works
  assert.equal(r1.status, 'active');
  assert.equal(state.refreshCalls, 1);

  expired.add('at-2'); // time passes; the second token expires too
  const r2 = await client.accountStatus(); // must refresh AGAIN, once, with rt-2
  assert.equal(r2.status, 'active');
  assert.equal(state.refreshCalls, 2, 'second expiry → exactly one more refresh');
  assert.equal(state.reuseSeen, false, 'no rotated token was ever re-presented');
  assert.equal(loadSession()?.refreshToken, 'rt-3');
});
