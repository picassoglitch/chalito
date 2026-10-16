-- M16 A (ADR 0022 §1): the fast live path.
--
-- Live-only events (`message.assistant.delta`, `terminal.output`, `screen.state` except "ended")
-- are no longer `session_events` rows. The agent hands a batch of them, still sealed to the
-- person's clients, to `chalito.live_send`, which broadcasts them on each client's private
-- `chalito:device:<id>` topic: the same recipients (the owner's non-revoked client devices) and
-- the same realtime.messages RLS as every pointer. Nothing is stored, so nothing durable can
-- depend on them: a client that joins late resyncs from the stored rows as before.
--
-- Clients still can't send on chalito topics (chalito_topics_guard); only this function, as the
-- database, does. It checks that the caller is an active agent, that every event is a live-only
-- event of that device for one of its own sessions, that content is sealed, and a token bucket
-- per device (300 events, refilled at 100/s: the ADR's 100 events/s per device).

insert into chalito_private.rate_limits (tbl, capacity, per_second) values ('live', 300, 100)
on conflict (tbl) do nothing;

create or replace function chalito.live_send(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dev text := chalito.jwt_device_id();
  own text := chalito.jwt_owner();
  n integer;
  e jsonb;
  lim record;
  left_ numeric;
begin
  if not coalesce(chalito_private.active_agent(), false) or dev is null or own is null then
    raise exception 'chalito: only an active agent may send live events' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'chalito: live events must be an array' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_events);
  if n < 1 or n > 64 then
    raise exception 'chalito: 1 to 64 live events per call' using errcode = '22023';
  end if;
  if octet_length(p_events::text) > 262144 then
    raise exception 'chalito: live batch too large' using errcode = '54000';
  end if;

  for e in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(e) is distinct from 'object'
       or (e ->> 'v') is distinct from '1'
       or coalesce(e ->> 'type', '') not in ('message.assistant.delta', 'terminal.output', 'screen.state')
       or (e ->> 'type' = 'screen.state' and e ->> 'state' = 'ended')
       or (e ->> 'deviceId') is distinct from dev
       or (e ->> 'type' = 'message.assistant.delta' and jsonb_typeof(e -> 'ct') is distinct from 'object')
       or (e ->> 'type' = 'terminal.output' and jsonb_typeof(e -> 'dataCt') is distinct from 'object')
    then
      raise exception 'chalito: not a sealed live-only event of this device' using errcode = '22023';
    end if;
    if not exists (select 1 from chalito.sessions s
                   where s.owner = own and s.sid = e ->> 'sid' and s.device_id = dev) then
      raise exception 'chalito: live event for a session that is not this device''s' using errcode = '42501';
    end if;
  end loop;

  -- One token per event (S7's bucket table, as for client inserts).
  select capacity, per_second into lim from chalito_private.rate_limits where tbl = 'live';
  insert into chalito_private.rate_buckets as b (device_id, tbl, tokens, updated_at)
  values (dev, 'live', lim.capacity - n, clock_timestamp())
  on conflict (device_id, tbl) do update
    set tokens = least(lim.capacity::numeric,
                       b.tokens + extract(epoch from clock_timestamp() - b.updated_at) * lim.per_second) - n,
        updated_at = clock_timestamp()
  returning tokens into left_;
  if left_ < 0 then
    raise exception 'chalito: rate limit for % on live', dev using errcode = 'PT429';
  end if;

  perform chalito_private.send_to_devices(
    own, 'live',
    jsonb_build_object('table', 'live', 'op', 'events', 'deviceId', dev, 'events', p_events),
    null, 'client');
  return n;
end
$$;

revoke execute on function chalito.live_send(jsonb) from public, anon, service_role;
grant execute on function chalito.live_send(jsonb) to authenticated;
