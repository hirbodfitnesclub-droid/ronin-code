import http from 'node:http';

/**
 * Mock CheapVibeCode provider implementing the reseller contract
 * (~/workspace/user/files/reseller-api-agent__1__0_afjn.md) faithfully enough
 * to test money-safety: one-time plaintext on create, ADDITIVE top-ups,
 * absolute reductions (idempotent, floored at tokens_used), freeze/unfreeze
 * via `active`, irreversible delete, 30-row logs cap + total, per-key balance,
 * and FAULT INJECTION: an "ambiguous" fault commits the mutation and then
 * hangs past the client timeout (or drops the response).
 *
 * Balance semantics in this mock: finite key → token_limit − tokens_used;
 * primary → poolBalance. (The real contract's wording is ambiguous; the
 * server treats any balance as an upper bound only — §8.2.)
 */
export const MOCK_PRIMARY = 'sk-primary-test-secret';

export function startMockCvc() {
  const state = {
    keys: new Map(), // plaintext -> record
    calls: { create: 0, edit: 0, balance: 0, logs: 0, chat: 0 },
    createNames: [],
    lastChatAuth: null,
    lastChatBody: null,
    poolBalance: 1_000_000_000,
    faults: { createAmbiguous: 0, editAmbiguous: 0, createDrop: 0 },
    counter: 0,
  };
  const primaryRec = {
    name: 'primary', token_limit: null, tokens_used: 0, is_active: true, is_primary: true, logs: [],
  };
  state.keys.set(MOCK_PRIMARY, primaryRec);
  state.primary = primaryRec;

  const send = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const err = (res, status, code) => send(res, status, { error: { message: code, type: 'mock_error', code } });
  const authKey = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
  const hang = () => new Promise((r) => setTimeout(r, 5_000));

  function balanceOf(rec) {
    if (rec.is_primary) return state.poolBalance;
    if (rec.token_limit === null) return state.poolBalance;
    return Math.max(0, rec.token_limit - rec.tokens_used);
  }
  state.balanceOf = balanceOf;
  state.addLog = (plaintext, entry) => {
    const rec = state.keys.get(plaintext);
    if (!rec) throw new Error('addLog: unknown key');
    rec.logs.unshift({
      model: 'gpt-5.6-terra', reasoning_effort: 'medium', fast: false,
      input_tokens: 100, output_tokens: 50, cached_tokens: 0,
      cost_tokens: 150, latency_ms: 100, status: 'success', error_message: '',
      created_at: new Date().toISOString(), ...entry,
    });
    rec.tokens_used += Number(entry.cost_tokens ?? 150);
  };
  state.byName = (name) => [...state.keys.entries()].find(([, r]) => r.name === name)?.[0] ?? null;
  state.recByName = (name) => [...state.keys.values()].find((r) => r.name === name) ?? null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://local');
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const key = authKey(req);
      const rec = state.keys.get(key);

      if (url.pathname === '/v1/keys' && req.method === 'POST') {
        state.calls.create++;
        if (key !== MOCK_PRIMARY) return err(res, 403, 'not_primary');
        if (!Number.isInteger(body.token_limit) || body.token_limit <= 0) return err(res, 400, 'invalid_token_limit');
        state.counter++;
        const plaintext = `sk-ronin-test-${state.counter}-${Math.random().toString(36).slice(2, 10)}`;
        const newRec = {
          name: String(body.name ?? 'Additional key').slice(0, 64),
          token_limit: body.token_limit, tokens_used: 0, is_active: true, is_primary: false, logs: [],
          allowed_models: body.allowed_models ?? null,
        };
        state.keys.set(plaintext, newRec);
        state.createNames.push(newRec.name);
        if (state.faults.createAmbiguous > 0) {
          state.faults.createAmbiguous--;
          await hang(); // committed, response lost in transit time
          try { return send(res, 201, { key: plaintext, meta: metaOf(newRec) }); } catch { return; }
        }
        if (state.faults.createDrop > 0) {
          state.faults.createDrop--;
          res.socket.destroy(); // committed, response dropped entirely
          return;
        }
        return send(res, 201, { key: plaintext, meta: metaOf(newRec) });
      }

      if (url.pathname === '/v1/keys/edit' && req.method === 'POST') {
        state.calls.edit++;
        if (key !== MOCK_PRIMARY) return err(res, 403, 'not_primary');
        const target = state.keys.get(body.key);
        if (!target) return err(res, 404, 'key_not_found');
        // Apply the mutation (validation per contract §4/§5/§6)
        let applyErr = null;
        if (body.delete === true) {
          if (body.additional_tokens !== undefined || body.token_limit !== undefined || body.active !== undefined) {
            applyErr = [400, 'delete_cannot_combine'];
          } else if (target.is_primary) applyErr = [409, 'primary_no_replacement'];
          else state.keys.delete(body.key);
        } else {
          if (body.additional_tokens !== undefined) {
            if (!Number.isInteger(body.additional_tokens) || body.additional_tokens <= 0) applyErr = [400, 'invalid_additional_tokens'];
            else if (target.token_limit === null) applyErr = [409, 'unlimited_cannot_topup'];
            else target.token_limit += body.additional_tokens;
          }
          if (!applyErr && body.token_limit !== undefined) {
            if (body.additional_tokens !== undefined) applyErr = [400, 'cannot_combine_limit_and_additional'];
            else if (!Number.isInteger(body.token_limit) || body.token_limit <= 0) applyErr = [400, 'invalid_token_limit'];
            else if (body.token_limit > target.token_limit) applyErr = [400, 'limit_increase_not_allowed'];
            else if (body.token_limit < target.tokens_used) applyErr = [400, 'limit_below_used'];
            else target.token_limit = body.token_limit;
          }
          if (!applyErr && body.active !== undefined) target.is_active = Boolean(body.active);
          if (!applyErr && body.allowed_models !== undefined) target.allowed_models = body.allowed_models;
        }
        if (applyErr) return err(res, applyErr[0], applyErr[1]);
        if (state.faults.editAmbiguous > 0) {
          state.faults.editAmbiguous--;
          await hang();
          try { return send(res, 200, { status: 'ok' }); } catch { return; }
        }
        if (body.delete === true) return send(res, 200, { status: 'deleted' });
        return send(res, 200, { meta: metaOf(target) });
      }

      if (url.pathname === '/v1/balance' && req.method === 'GET') {
        state.calls.balance++;
        if (!rec) return err(res, 401, 'invalid_key');
        return send(res, 200, { balance: balanceOf(rec) });
      }

      if (url.pathname === '/v1/keys/logs' && req.method === 'GET') {
        state.calls.logs++;
        if (!rec) return err(res, 401, 'invalid_key');
        return send(res, 200, { logs: rec.logs.slice(0, 30), total: rec.logs.length });
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        state.calls.chat++;
        state.lastChatAuth = req.headers.authorization;
        state.lastChatBody = body;
        if (!rec) return err(res, 401, 'invalid_key');
        if (!rec.is_active) return err(res, 403, 'key_inactive');
        if (!rec.is_primary && rec.token_limit !== null && rec.tokens_used >= rec.token_limit) {
          return err(res, 402, 'allowance_exhausted');
        }
        const cost = 150;
        rec.tokens_used += cost;
        rec.logs.unshift({
          model: body.model, reasoning_effort: null, fast: body.service_tier === 'priority',
          input_tokens: 100, output_tokens: 50, cached_tokens: 0, cost_tokens: cost,
          latency_ms: 42, status: 'success', error_message: '', created_at: new Date().toISOString(),
        });
        return send(res, 200, {
          id: 'chatcmpl-mock', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
      }

      return err(res, 404, 'no_route');
    });
  });

  function metaOf(r) {
    return {
      name: r.name, allowed_models: r.allowed_models ?? [],
      token_limit: r.token_limit, tokens_used: r.tokens_used,
      is_active: r.is_active, is_primary: r.is_primary,
    };
  }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}
