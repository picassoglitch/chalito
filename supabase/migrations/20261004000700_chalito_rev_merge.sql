-- Resync revisions, session merge, and quieter device broadcasts.
--
-- 1. `cursor` is set once on insert, so `cursor > last` misses updates made while a device was
--    offline (e.g. a decision attached to an approval). Every pushed table gets `rev`, taken from
--    one shared sequence on INSERT and again on every UPDATE. Pointers carry `rev`; devices resync
--    with `rev > last_rev`. `cursor` stays as the insertion order.
-- 2. `chalito.session_merge(sid, patch)`: the Firestore `setDoc(..., { merge: true })` the agent
--    uses for session cards, as one statement. Security invoker, so RLS decides who may call it.
-- 3. A device row updated only in presence columns (last_seen_at, presence) no longer fans out to
--    every phone; the agent's refresh touches last_seen_at on every token refresh.

create sequence chalito_private.rev_seq as bigint;
revoke all on sequence chalito_private.rev_seq from public, anon, authenticated;

-- Security definer, so clients need no privilege on the sequence and can never set `rev` themselves.
create or replace function chalito_private.bump_rev()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.rev := nextval('chalito_private.rev_seq');
  return new;
end
$$;
revoke execute on function chalito_private.bump_rev() from public;

do $$
declare
  t text;
begin
  foreach t in array array['devices', 'pairing_codes', 'commands', 'sessions', 'session_events',
                           'approvals', 'notifications']
  loop
    execute format('alter table chalito.%I add column rev bigint', t);
    execute format('update chalito.%I set rev = nextval(''chalito_private.rev_seq'')', t);
    execute format('alter table chalito.%I alter column rev set not null', t);
    execute format('create trigger bump_rev before insert or update on chalito.%I
                    for each row execute function chalito_private.bump_rev()', t);
  end loop;
end
$$;

create index devices_owner_rev_idx on chalito.devices (owner, rev);
create index pairing_codes_rev_idx on chalito.pairing_codes (rev);
create index commands_target_rev_idx on chalito.commands (target_device_id, rev);
create index sessions_owner_rev_idx on chalito.sessions (owner, rev);
create index session_events_owner_rev_idx on chalito.session_events (owner, rev);
create index approvals_owner_rev_idx on chalito.approvals (owner, rev);
create index notifications_owner_rev_idx on chalito.notifications (owner, rev);

-- `rev` is readable through the table-wide select grants and in no insert/update column grant,
-- so it is never client-writable.

-- ---------------------------------------------------------------- pointers carry rev
create or replace function chalito_private.broadcast_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  key jsonb;
begin
  key := case tg_table_name
    when 'commands' then jsonb_build_object('target_device_id', r -> 'target_device_id', 'id', r -> 'id')
    when 'sessions' then jsonb_build_object('sid', r -> 'sid')
    when 'session_events' then jsonb_build_object('sid', r -> 'sid', 'eid', r -> 'eid')
    when 'approvals' then jsonb_build_object('aid', r -> 'aid')
    when 'notifications' then jsonb_build_object('nid', r -> 'nid')
    when 'devices' then jsonb_build_object('device_id', r -> 'device_id')
    else '{}'::jsonb
  end;
  perform chalito_private.send_to_devices(
    r ->> 'owner',
    tg_table_name,
    jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'key', key, 'rev', r -> 'rev'),
    case when tg_argv[0] = 'target' then r ->> 'target_device_id' end,
    case when tg_argv[0] = 'clients' then 'client' end
  );
  return null;
end
$$;

create or replace function chalito_private.broadcast_pairing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('table', 'pairing_codes', 'op', lower(tg_op),
                       'key', jsonb_build_object('code_id', new.code_id), 'rev', new.rev),
    'pairing_codes', 'pairing:' || new.code_id, true);
  return null;
end
$$;

-- ---------------------------------------------------------------- quieter device broadcasts
-- Only updates that change something other than presence (and the bookkeeping `rev`) fan out.
drop trigger devices_broadcast on chalito.devices;
create trigger devices_broadcast after update on chalito.devices
  for each row
  when ((to_jsonb(old) - array['last_seen_at', 'presence', 'rev'])
        is distinct from (to_jsonb(new) - array['last_seen_at', 'presence', 'rev']))
  execute function chalito_private.broadcast_change('all');

-- ---------------------------------------------------------------- session merge
-- Upserts the caller's session row and shallow-merges `p_patch` into `doc`. Security invoker:
-- the insert must pass sessions_agent_create and the merge sessions_agent_update, so only the
-- owning agent may call it (another device hitting an existing row gets a 42501 error).
create or replace function chalito.session_merge(p_sid text, p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'chalito: patch must be a JSON object' using errcode = '22023';
  end if;
  insert into chalito.sessions as s (owner, sid, device_id, doc)
  values (chalito.jwt_owner(), p_sid, chalito.jwt_device_id(), p_patch)
  on conflict (owner, sid) do update set doc = coalesce(s.doc, '{}'::jsonb) || excluded.doc;
end
$$;
revoke execute on function chalito.session_merge(text, jsonb) from public;
grant execute on function chalito.session_merge(text, jsonb) to authenticated;
