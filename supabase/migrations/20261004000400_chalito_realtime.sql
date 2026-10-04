-- Realtime: Broadcast from the database to private per-device channels (ADR 0017 §Realtime).
--
-- Supabase recommends Broadcast over Postgres Changes "for scalability and security"
-- (docs/guides/realtime/subscribing-to-database-changes). Triggers call
-- `realtime.send(payload, event, topic, private => true)` once per non-revoked target device:
--   device:<device_id>   every change a device should know about
--   pairing:<code_id>    the agent waiting on its pairing code (pairing-watch token)
-- Payloads are pointers only ({table, op, key, cursor}); the device then reads the row through
-- the Data API, under RLS. On (re)subscribe a device resyncs with `cursor > last_cursor`.
--
-- Authorization is RLS on realtime.messages, checked when the channel is joined and again
-- whenever the client sends a new access token. Clients join with `config: { private: true }`.

create or replace function chalito_private.send_to_devices(
  p_owner text,
  p_event text,
  p_payload jsonb,
  p_device_id text default null,
  p_role text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
begin
  for d in
    select device_id from chalito.devices
    where owner = p_owner and not revoked
      and (p_device_id is null or device_id = p_device_id)
      and (p_role is null or role = p_role)
  loop
    perform realtime.send(p_payload, p_event, 'device:' || d.device_id, true);
  end loop;
end
$$;
revoke execute on function chalito_private.send_to_devices(text, text, jsonb, text, text) from public;

-- One trigger function for every broadcast table; TG_ARGV[0] picks the audience:
--   'all'            every active device of the owner
--   'target'         only commands.target_device_id
--   'clients'        only the owner's client devices
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
    jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'key', key, 'cursor', r -> 'cursor'),
    case when tg_argv[0] = 'target' then r ->> 'target_device_id' end,
    case when tg_argv[0] = 'clients' then 'client' end
  );
  return null;
end
$$;
revoke execute on function chalito_private.broadcast_change() from public;

create trigger commands_broadcast after insert on chalito.commands
  for each row execute function chalito_private.broadcast_change('target');
create trigger approvals_broadcast after insert or update on chalito.approvals
  for each row execute function chalito_private.broadcast_change('all');
create trigger sessions_broadcast after insert or update on chalito.sessions
  for each row execute function chalito_private.broadcast_change('clients');
create trigger session_events_broadcast after insert on chalito.session_events
  for each row execute function chalito_private.broadcast_change('clients');
create trigger notifications_broadcast after insert or update on chalito.notifications
  for each row execute function chalito_private.broadcast_change('all');
-- Revocation, lastEvent, devMode/policy changes. A device revoked by this update is no longer
-- an audience (send_to_devices skips revoked devices).
create trigger devices_broadcast after update on chalito.devices
  for each row execute function chalito_private.broadcast_change('all');

-- The pairing watcher has no device: it gets its own topic.
create or replace function chalito_private.broadcast_pairing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('table', 'pairing_codes', 'op', lower(tg_op),
                       'key', jsonb_build_object('code_id', new.code_id), 'cursor', new.cursor),
    'pairing_codes', 'pairing:' || new.code_id, true);
  return null;
end
$$;
revoke execute on function chalito_private.broadcast_pairing() from public;
create trigger pairing_codes_broadcast after update on chalito.pairing_codes
  for each row execute function chalito_private.broadcast_pairing();

-- ---------------------------------------------------------------- realtime.messages RLS
-- Read (receive) only on the caller's own topic, only while the device is active. Nobody but the
-- database may send on chalito topics (no insert policy).
create or replace function chalito_private.pairing_watch_ok(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from chalito.pairing_codes c where c.code_id = p_code and c.expires_at > now())
$$;
revoke execute on function chalito_private.pairing_watch_ok(text) from public;
grant execute on function chalito_private.pairing_watch_ok(text) to authenticated;

create policy chalito_device_topic_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'device:' || (select chalito.jwt_device_id())
    and (select chalito_private.device_ok())
  );

create policy chalito_pairing_topic_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select chalito.jwt_role()) = 'pairing'
    and (select realtime.topic()) = 'pairing:' || (select chalito.jwt_pairing_code())
    and (select chalito_private.pairing_watch_ok(chalito.jwt_pairing_code()))
  );
