-- Ronin Code — money RPC layer (migration 2)
--
-- EVERY mutation of ledger / credit_lots / holds / orders goes through these
-- SECURITY DEFINER functions. Each one reproduces the exact semantics of the
-- previous SQLite implementation (server/src/ledger.js, server/src/orders.js):
--   * balance = SUM(ledger.delta_tokens), never written directly;
--   * balance == SUM(credit_lots.tokens_left) at all times;
--   * per-user serialization via SELECT … FOR UPDATE on the profile row, so
--     concurrent reserves can never overdraw (the old BEGIN IMMEDIATE role);
--   * claim approval is one atomic transaction; a second review is rejected;
--   * all expiry math uses the database clock (now()) — server time only.
--
-- EXECUTE is revoked from PUBLIC/anon/authenticated at the end of this file:
-- only the service role (our servers) may call these functions.

-- ── Internal helpers (not callable by API roles) ────────────────────────────

create or replace function public._balance(p_user_id uuid)
returns bigint language sql stable as $$
  select coalesce(sum(delta_tokens), 0)::bigint from public.ledger where user_id = p_user_id;
$$;

create or replace function public._unexpired_lot_tokens(p_user_id uuid)
returns bigint language sql stable as $$
  select coalesce(sum(tokens_left), 0)::bigint from public.credit_lots
  where user_id = p_user_id and (expires_at is null or expires_at > now());
$$;

create or replace function public._active_hold_tokens(p_user_id uuid)
returns bigint language sql stable as $$
  select coalesce(sum(reserved_tokens), 0)::bigint from public.holds
  where user_id = p_user_id and status = 'reserved';
$$;

create or replace function public._post_ledger(
  p_user_id uuid, p_kind text, p_delta bigint, p_amount bigint,
  p_ref_type text, p_ref_id text, p_actor text,
  p_idempotency_key text, p_request_id text, p_note text, p_meta jsonb
) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into public.ledger (user_id, kind, delta_tokens, amount_tokens, balance_after,
    ref_type, ref_id, actor, idempotency_key, request_id, note, meta)
  values (p_user_id, p_kind, p_delta, p_amount,
    public._balance(p_user_id) + p_delta,
    p_ref_type, p_ref_id, p_actor, p_idempotency_key, p_request_id, p_note, p_meta)
  returning id into v_id;
  return v_id;
end;
$$;

-- Consume tokens from lots, oldest-expiring first (FIFO). Caller holds the
-- user-row lock and guarantees coverage. Returns tokens actually consumed.
create or replace function public._consume_lots(p_user_id uuid, p_tokens bigint)
returns bigint language plpgsql as $$
declare v_remaining bigint := p_tokens; v_lot record; v_take bigint;
begin
  for v_lot in
    select id, tokens_left from public.credit_lots
    where user_id = p_user_id and tokens_left > 0
      and (expires_at is null or expires_at > now())
    order by expires_at asc nulls last, id asc
  loop
    exit when v_remaining <= 0;
    v_take := least(v_lot.tokens_left, v_remaining);
    update public.credit_lots set tokens_left = tokens_left - v_take where id = v_lot.id;
    v_remaining := v_remaining - v_take;
  end loop;
  return p_tokens - v_remaining;
end;
$$;

-- Grant: ledger entry + a credit lot, idempotent on the ledger key.
-- Returns the ledger entry id (the EXISTING one when replayed).
create or replace function public._grant(
  p_user_id uuid, p_tokens bigint, p_kind text, p_ref_type text, p_ref_id text,
  p_actor text, p_note text, p_meta jsonb, p_expires_at timestamptz, p_idempotency_key text
) returns bigint language plpgsql as $$
declare v_entry_id bigint;
begin
  if p_idempotency_key is not null then
    insert into public.ledger (user_id, kind, delta_tokens, balance_after, ref_type, ref_id, actor, idempotency_key, note, meta)
    values (p_user_id, p_kind, p_tokens, public._balance(p_user_id) + p_tokens,
            p_ref_type, p_ref_id, p_actor, p_idempotency_key, p_note, p_meta)
    on conflict (idempotency_key) where idempotency_key is not null do nothing
    returning id into v_entry_id;
    if v_entry_id is null then
      select id into v_entry_id from public.ledger where idempotency_key = p_idempotency_key;
      return v_entry_id;  -- replay: the lot was created by the original grant
    end if;
  else
    v_entry_id := public._post_ledger(p_user_id, p_kind, p_tokens, null,
      p_ref_type, p_ref_id, p_actor, null, null, p_note, p_meta);
  end if;
  insert into public.credit_lots (user_id, source, tokens_total, tokens_left, expires_at)
  values (p_user_id,
          coalesce(p_ref_type, 'grant') || ':' || coalesce(p_ref_id, v_entry_id::text),
          p_tokens, p_tokens, p_expires_at);
  return v_entry_id;
end;
$$;

-- ── Public RPC: reads ───────────────────────────────────────────────────────

create or replace function public.spendable_tokens(p_user_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select public._unexpired_lot_tokens(p_user_id) - public._active_hold_tokens(p_user_id);
$$;

create or replace function public.ledger_balance(p_user_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select public._balance(p_user_id);
$$;

-- ── Public RPC: grant (purchase approval internals / admin charge) ──────────

create or replace function public.grant_credit(
  p_user_id uuid, p_tokens bigint, p_kind text default 'purchase',
  p_ref_type text default null, p_ref_id text default null, p_actor text default null,
  p_note text default null, p_meta jsonb default null,
  p_expires_at timestamptz default null, p_idempotency_key text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  v_id := public._grant(p_user_id, p_tokens, p_kind, p_ref_type, p_ref_id,
                        p_actor, p_note, p_meta, p_expires_at, p_idempotency_key);
  return v_id;
end;
$$;

-- ── Public RPC: holds (metering reserve / commit / release) ─────────────────

create or replace function public.reserve_hold(
  p_user_id uuid, p_request_id text, p_idempotency_key text,
  p_model text, p_multiplier numeric, p_reserved_tokens bigint, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hold public.holds; v_spendable bigint;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;

  if p_idempotency_key is not null then
    select * into v_hold from public.holds
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'replayed', true, 'hold', to_jsonb(v_hold));
    end if;
  end if;

  v_spendable := public._unexpired_lot_tokens(p_user_id) - public._active_hold_tokens(p_user_id);
  if v_spendable < p_reserved_tokens then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credit', 'spendable', v_spendable);
  end if;

  insert into public.holds (user_id, request_id, idempotency_key, model, multiplier, reserved_tokens)
  values (p_user_id, p_request_id, p_idempotency_key, p_model, p_multiplier, p_reserved_tokens)
  returning * into v_hold;

  perform public._post_ledger(p_user_id, 'hold', 0, p_reserved_tokens,
    'hold', v_hold.id::text, p_actor, null, p_request_id, null, null);
  return jsonb_build_object('ok', true, 'replayed', false, 'hold', to_jsonb(v_hold));
end;
$$;

create or replace function public.commit_hold(
  p_hold_id bigint, p_actual_tokens bigint, p_response_json jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hold public.holds; v_charge bigint;
begin
  select user_id into v_hold.user_id from public.holds where id = p_hold_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'hold_not_found'); end if;
  perform 1 from public.users where id = v_hold.user_id for update;
  select * into v_hold from public.holds where id = p_hold_id for update;
  if v_hold.status <> 'reserved' then
    return jsonb_build_object('ok', true, 'alreadySettled', true, 'chargedTokens', 0, 'hold', to_jsonb(v_hold));
  end if;

  -- The debit can never take the ledger below zero (prepaid model).
  v_charge := greatest(0, least(p_actual_tokens, public._balance(v_hold.user_id)));
  perform public._consume_lots(v_hold.user_id, v_charge);
  perform public._post_ledger(v_hold.user_id, 'consume', -v_charge, null,
    'hold', v_hold.id::text, 'system', null, v_hold.request_id, null,
    jsonb_build_object('model', v_hold.model, 'multiplier', v_hold.multiplier,
                       'reservedTokens', v_hold.reserved_tokens, 'uncappedActual', p_actual_tokens));
  update public.holds
    set status = 'committed', actual_tokens = p_actual_tokens,
        response_json = p_response_json, settled_at = now()
    where id = p_hold_id returning * into v_hold;
  return jsonb_build_object('ok', true, 'alreadySettled', false, 'chargedTokens', v_charge, 'hold', to_jsonb(v_hold));
end;
$$;

create or replace function public.release_hold(
  p_hold_id bigint, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_hold public.holds;
begin
  select user_id into v_hold.user_id from public.holds where id = p_hold_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'hold_not_found'); end if;
  perform 1 from public.users where id = v_hold.user_id for update;
  select * into v_hold from public.holds where id = p_hold_id for update;
  if v_hold.status <> 'reserved' then
    return jsonb_build_object('ok', true, 'alreadySettled', true, 'hold', to_jsonb(v_hold));
  end if;
  perform public._post_ledger(v_hold.user_id, 'release', 0, v_hold.reserved_tokens,
    'hold', v_hold.id::text, 'system', null, v_hold.request_id, null,
    case when p_reason is null then null else jsonb_build_object('reason', p_reason) end);
  -- Free the idempotency key so a legitimate client retry after an upstream
  -- failure can reserve again (the hold row itself stays for audit).
  update public.holds
    set status = 'released', settled_at = now(), idempotency_key = null
    where id = p_hold_id returning * into v_hold;
  return jsonb_build_object('ok', true, 'alreadySettled', false, 'hold', to_jsonb(v_hold));
end;
$$;

-- ── Public RPC: admin manual adjustment ─────────────────────────────────────

create or replace function public.adjust_credit(
  p_user_id uuid, p_tokens bigint, p_actor text, p_note text
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;
  if p_tokens > 0 then
    perform public._grant(p_user_id, p_tokens, 'adjust', 'admin', p_actor, p_actor, p_note, null, null, null);
  else
    if public._balance(p_user_id) + p_tokens < 0 then
      return jsonb_build_object('ok', false, 'error', 'insufficient_balance');
    end if;
    perform public._consume_lots(p_user_id, -p_tokens);
    perform public._post_ledger(p_user_id, 'adjust', p_tokens, null,
      'admin', p_actor, p_actor, null, null, p_note, null);
  end if;
  return jsonb_build_object('ok', true, 'balance', public._balance(p_user_id));
end;
$$;

-- ── Public RPC: card-to-card claims ─────────────────────────────────────────

create or replace function public.create_claim(
  p_user_id uuid, p_pack_id text, p_pack_title text, p_tokens bigint,
  p_price_rials bigint, p_payer_name text, p_card_last4 text,
  p_reference text, p_paid_at_text text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pending integer; v_order public.orders;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;
  select count(*) into v_pending from public.orders
  where user_id = p_user_id and status = 'pending';
  if v_pending >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_pending');
  end if;
  insert into public.orders (user_id, pack_id, pack_title, tokens, price_rials,
    payer_name, card_last4, reference, paid_at_text)
  values (p_user_id, p_pack_id, p_pack_title, p_tokens, p_price_rials,
    p_payer_name, p_card_last4, p_reference, p_paid_at_text)
  returning * into v_order;
  return jsonb_build_object('ok', true, 'order', to_jsonb(v_order));
end;
$$;

-- ONE atomic, idempotent approval: order update + credit grant + audit row.
-- A second review returns already_reviewed and can never double-credit.
create or replace function public.approve_claim(
  p_order_id bigint, p_admin_phone text, p_received_rials bigint default null,
  p_note text default null, p_validity_days integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order public.orders; v_received bigint; v_granted bigint; v_expires timestamptz;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'order_not_found'); end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_reviewed', 'status', v_order.status);
  end if;

  v_received := coalesce(p_received_rials, v_order.price_rials);
  if v_received < 0 then return jsonb_build_object('ok', false, 'error', 'invalid_amount'); end if;
  v_granted := v_order.tokens;
  if v_order.price_rials > 0 and v_received <> v_order.price_rials then
    v_granted := floor(v_order.tokens::numeric * v_received / v_order.price_rials)::bigint;
  end if;
  v_expires := case when p_validity_days is not null
                    then now() + make_interval(days => p_validity_days) end;

  update public.orders
    set status = 'approved', received_amount_rials = v_received,
        admin_note = p_note, reviewed_by = p_admin_phone, reviewed_at = now()
    where id = p_order_id returning * into v_order;

  if v_granted > 0 then
    perform public._grant(v_order.user_id, v_granted, 'purchase', 'order', v_order.id::text,
      'admin:' || p_admin_phone, p_note,
      jsonb_build_object('packId', v_order.pack_id, 'expectedRials', v_order.price_rials,
                         'receivedRials', v_received),
      v_expires, 'order-approve:' || v_order.id::text);
  end if;

  insert into public.admin_audit (actor, action, target, meta)
  values (p_admin_phone, 'order_approved', 'order:' || v_order.id::text,
          jsonb_build_object('userId', v_order.user_id, 'grantedTokens', v_granted,
                             'receivedRials', v_received));
  return jsonb_build_object('ok', true, 'order', to_jsonb(v_order), 'grantedTokens', v_granted);
end;
$$;

create or replace function public.reject_claim(
  p_order_id bigint, p_admin_phone text, p_reason text, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'order_not_found'); end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_reviewed', 'status', v_order.status);
  end if;
  update public.orders
    set status = 'rejected', reject_reason = p_reason, admin_note = p_note,
        reviewed_by = p_admin_phone, reviewed_at = now()
    where id = p_order_id returning * into v_order;
  insert into public.admin_audit (actor, action, target, meta)
  values (p_admin_phone, 'order_rejected', 'order:' || v_order.id::text,
          jsonb_build_object('userId', v_order.user_id, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'order', to_jsonb(v_order), 'grantedTokens', 0);
end;
$$;

-- ── Public RPC: expiry sweep ────────────────────────────────────────────────
-- Warns ~72h before expiry (once per lot) and debits expired leftovers through
-- `expire` ledger entries, preserving balance == SUM(lots.tokens_left).
-- Returns the affected lots (with phone) so the caller can send SMS.
create or replace function public.run_expiry_sweep()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_warned jsonb := '[]'::jsonb; v_expired jsonb := '[]'::jsonb; v_lot record;
begin
  for v_lot in
    select l.id, l.user_id, l.tokens_left, l.expires_at, u.phone
    from public.credit_lots l join public.users u on u.id = l.user_id
    where l.tokens_left > 0 and l.expires_at is not null and l.warned_at is null
      and l.expires_at > now() and l.expires_at <= now() + interval '72 hours'
  loop
    update public.credit_lots set warned_at = now() where id = v_lot.id;
    v_warned := v_warned || jsonb_build_object(
      'lotId', v_lot.id, 'userId', v_lot.user_id, 'phone', v_lot.phone,
      'tokensLeft', v_lot.tokens_left, 'expiresAt', v_lot.expires_at);
  end loop;

  for v_lot in
    select l.id, l.user_id, l.tokens_left, l.expires_at, l.source, u.phone
    from public.credit_lots l join public.users u on u.id = l.user_id
    where l.tokens_left > 0 and l.expires_at is not null and l.expires_at <= now()
  loop
    perform 1 from public.users where id = v_lot.user_id for update;
    perform public._post_ledger(v_lot.user_id, 'expire', -v_lot.tokens_left, null,
      'lot', v_lot.id::text, 'system', null, null, null,
      jsonb_build_object('lotSource', v_lot.source));
    update public.credit_lots set tokens_left = 0 where id = v_lot.id;
    v_expired := v_expired || jsonb_build_object(
      'lotId', v_lot.id, 'userId', v_lot.user_id, 'phone', v_lot.phone,
      'tokensLeft', v_lot.tokens_left, 'expiresAt', v_lot.expires_at);
  end loop;

  return jsonb_build_object('warned', v_warned, 'expired', v_expired);
end;
$$;

-- ── Public RPC: daily account revalidation ──────────────────────────────────
-- The single lightweight status the desktop app polls on every launch and at
-- least once a day. Everything is computed from server-side state with the
-- server clock; the device registry is authoritative — a revoked device gets
-- deviceAuthorized=false even if its access token is still within its TTL.
create or replace function public.account_status(p_user_id uuid, p_device_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user public.users;
  v_device public.devices;
  v_authorized boolean := false;
  v_lots jsonb;
begin
  select * into v_user from public.users where id = p_user_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'user_not_found'); end if;

  if p_device_id is not null then
    select * into v_device from public.devices
    where id = p_device_id and user_id = p_user_id;
    if found and v_device.revoked_at is null then
      v_authorized := true;
      update public.devices set last_seen_at = now() where id = v_device.id;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'tokensLeft', tokens_left, 'expiresAt', expires_at)
           order by expires_at asc nulls last, id asc), '[]'::jsonb)
    into v_lots
  from public.credit_lots
  where user_id = p_user_id and tokens_left > 0
    and (expires_at is null or expires_at > now());

  return jsonb_build_object(
    'ok', true,
    'serverTime', now(),
    'status', case when v_user.is_active then 'active' else 'disabled' end,
    'isActive', v_user.is_active,
    'balanceTokens', public._balance(p_user_id),
    'spendableTokens', public._unexpired_lot_tokens(p_user_id) - public._active_hold_tokens(p_user_id),
    'lots', v_lots,
    'deviceAuthorized', v_authorized,
    'activeDevices', (select count(*) from public.devices
                      where user_id = p_user_id and revoked_at is null)
  );
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Only the service role may execute the RPC surface. (Helpers keep PUBLIC
-- revoked too; definer functions call them with owner rights internally.)
revoke execute on all functions in schema public from public;
grant execute on function
  public.spendable_tokens(uuid), public.ledger_balance(uuid),
  public.grant_credit(uuid, bigint, text, text, text, text, text, jsonb, timestamptz, text),
  public.reserve_hold(uuid, text, text, text, numeric, bigint, text),
  public.commit_hold(bigint, bigint, jsonb),
  public.release_hold(bigint, text),
  public.adjust_credit(uuid, bigint, text, text),
  public.create_claim(uuid, text, text, bigint, bigint, text, text, text, text),
  public.approve_claim(bigint, text, bigint, text, integer),
  public.reject_claim(bigint, text, text, text),
  public.run_expiry_sweep(),
  public.account_status(uuid, uuid)
to service_role;
