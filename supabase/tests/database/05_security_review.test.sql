-- Security review fixes (docs/reviews/supabase-review.md): S2 privileges, S4 realtime guard under a
-- permissive hub policy, S7 rate buckets and coalesced events, S8 session ownership, S9 clamps.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);
-- pgTAP lives in `extensions`; let the server role call it inside this (rolled-back) test only.
grant usage on schema extensions to chalito_server;

create function pg_temp.login(claims jsonb, topic text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  perform set_config('realtime.topic', coalesce(topic, ''), true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text, topic text default null)
returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role))), topic) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('realtime.topic', '', true);
end $$;
create function pg_temp.count(q text) returns integer language plpgsql as $$
declare n integer;
begin
  execute format('select count(*) from (%s) as q', q) into n;
  return n;
end $$;
create function pg_temp.sent(p_topic text, p_table text, p_op text default null) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = p_table and (p_op is null or payload ->> 'op' = p_op)
    and inserted_at >= now() $$;

insert into chalito.tenants (id) values ('sr-user');
insert into chalito.users (id, tenant_id) values ('sr-user', 'sr-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('sr-user', 'sr_phone',  'client', 'phone',   'ios',   'Phone', 'ps', 'pb', 'fp', 'first_client', md5('sr_phone')::uuid),
  ('sr-user', 'sr_agent',  'agent',  'desktop', 'linux', 'Desk',  'ps', 'pb', 'fp', 'pairing',      md5('sr_agent')::uuid),
  ('sr-user', 'sr_agent2', 'agent',  'laptop',  'macos', 'Lap',   'ps', 'pb', 'fp', 'pairing',      md5('sr_agent2')::uuid);
insert into chalito.sessions (owner, sid, device_id) values ('sr-user', 'sr_s1', 'sr_agent'), ('sr-user', 'sr_s2', 'sr_agent2');

-- ================================================================ S2: privileges
set local role service_role;
select throws_ok($$select * from chalito.devices$$, '42501', null, 'S2: the hub''s service_role can''t read chalito tables');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('sr-user', 'sr_agent', 'x', '{"relayedBy": "mcp-gateway"}', 'x')$$, '42501', null,
  'S2: nor forge relayed commands');
select throws_ok($$select * from chalito_private.private_recovery$$, '42501', null, 'S2: nor read chalito_private');
select throws_ok($$select chalito_private.purge_expired()$$, '42501', null, 'S2: nor call its functions');
reset role;

set local role chalito_server;
select lives_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('sr-user', 'sr_agent', 'relay1', '{"relayedBy": "mcp-gateway", "body": {}}', 'mcp-gateway')$$,
  'S2: chalito_server relays a command');
select is(pg_temp.count($$select 1 from chalito.devices where owner = 'sr-user'$$), 3, 'S2: chalito_server reads devices');
select is(pg_temp.count($$select 1 from (select 1 from chalito.devices where device_id = 'sr_agent2' for update) d$$), 1,
  'S2: chalito_server may lock devices for update (revocation)');
select throws_ok($$delete from chalito.devices where device_id = 'sr_agent2'$$, '42501', null,
  'S2: chalito_server has no grants beyond what the server does (no device delete)');
select throws_ok($$select * from chalito.reminders$$, '42501', null, 'S2: nor on the stub tables');
select throws_ok($$select * from chalito_private.rate_buckets$$, '42501', null, 'S2: nor on internal bookkeeping');
reset role;

set local role anon;
select throws_ok($$select chalito.jwt_owner()$$, '42501', null, 'S2: anon can''t even call the claim helpers');
reset role;

-- ================================================================ S4: realtime guard
-- A hub-style permissive policy on realtime.messages (the Realtime quickstart shape).
create policy hub_open_read on realtime.messages for select to authenticated using (true);
create policy hub_open_send on realtime.messages for insert to authenticated with check (true);

insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
values ('sr-user', 'sr_agent', 'sr_c1', '{"ctx": "chalito.command.v1"}', 'sr_phone');
select is((select count(*)::int from realtime.messages where topic = 'chalito:device:sr_agent'
  and payload -> 'key' ->> 'id' = 'sr_c1' and inserted_at >= now()), 1, 'S4: topics are namespaced chalito:device:<id>');

select pg_temp.login('{"sub": "hub-user-9", "app_metadata": {"provider": "email"}}', 'chalito:device:sr_agent');
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:device:sr_agent'$$), 0,
  'S4: a hub user can''t read a chalito topic despite a permissive hub policy');
select throws_ok($$insert into realtime.messages (topic, extension, payload, event, private)
  values ('chalito:device:sr_agent', 'broadcast', '{"table": "commands"}', 'commands', true)$$, '42501', null,
  'S4: nor send on one');
select pg_temp.logout();
insert into realtime.messages (topic, extension, payload, event, private)
values ('hub:lobby', 'broadcast', '{"hello": 1}', 'hello', true);
select pg_temp.login('{"sub": "hub-user-9", "app_metadata": {"provider": "email"}}', 'hub:lobby');
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'hub:lobby'$$), 1,
  'S4: the hub''s own topics are untouched by the guard');
select lives_ok($$insert into realtime.messages (topic, extension, payload, event, private)
  values ('hub:lobby', 'broadcast', '{"hi": 2}', 'hi', true)$$, 'S4: hub clients still send on hub topics');

select pg_temp.as_device('sr-user', 'sr_phone', 'client', 'chalito:device:sr_agent');
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:device:sr_agent'$$), 0,
  'S4: a Chalito device can''t read another device''s topic either');
select throws_ok($$insert into realtime.messages (topic, extension, payload, event, private)
  values ('chalito:device:sr_phone', 'broadcast', '{}', 'commands', true)$$, '42501', null,
  'S4: nor send, even on its own topic');
select pg_temp.as_device('sr-user', 'sr_agent', 'agent', 'chalito:device:sr_agent');
select ok(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:device:sr_agent'$$) > 0,
  'S4: the device still receives on its own topic');
select pg_temp.logout();

-- ================================================================ S9: clamps
select pg_temp.as_device('sr-user', 'sr_agent2', 'agent');
select lives_ok($$insert into chalito.call_lines (owner, lid, notification_id, device_id, sid, line, expires_at)
  values ('sr-user', 'cl1', 'n1', 'sr_agent2', 'sr_s2', 'Hola', now() + interval '1 year')$$,
  'S9: a far call-line expiry is accepted...');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, created_at, expires_at) values ('sr-user', 'ap1', 'sr_agent2', 'sr_s2', 'r', 'tool',
  'LOW', 'local', false, '{}', now() + interval '1 year', now() + interval '1 year')$$, '42501', null,
  'S9: devices can''t set an approval''s created_at');
select lives_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, expires_at) values ('sr-user', 'ap2', 'sr_agent2', 'sr_s2', 'r', 'tool',
  'LOW', 'local', false, '{}', now() + interval '9 minutes')$$, 'S9: an approval within the TTL is accepted');
select pg_temp.as_device('sr-user', 'sr_phone', 'client');
select lives_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id, expires_at)
  values ('sr-user', 'sr_agent2', 'far', '{"ctx": "chalito.command.v1"}', 'sr_phone', now() + interval '1 year')$$,
  'S9: a far command expiry is accepted...');
select pg_temp.logout();
select ok((select expires_at <= now() + interval '30 minutes' from chalito.call_lines where lid = 'cl1'),
  'S9: ...and clamped to 30 minutes for call lines');
select ok((select expires_at <= now() + interval '10 minutes' from chalito.commands where id = 'far'),
  'S9: ...and to 10 minutes for commands');

-- ================================================================ S7: rate buckets
delete from chalito_private.rate_buckets;  -- start from full buckets (S9 above spent tokens)
-- Freeze refill for this check: the bucket refills by wall clock, so a slow runner would refill
-- a token mid-burst and let the 31st insert through. (Rolled back with the test transaction.)
update chalito_private.rate_limits set per_second = 0.000001 where tbl = 'commands';
select pg_temp.as_device('sr-user', 'sr_phone', 'client');
select lives_ok($t$ do $b$ begin
  for i in 1..30 loop
    insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('sr-user', 'sr_agent', 'burst' || i, '{"ctx": "chalito.command.v1"}', 'sr_phone');
  end loop; end $b$ $t$, 'S7: a client sends a burst up to the bucket''s capacity');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('sr-user', 'sr_agent', 'burst31', '{"ctx": "chalito.command.v1"}', 'sr_phone')$$, 'PT429', null,
  'S7: the next insert is rate limited (HTTP 429)');
select pg_temp.logout();
set local role chalito_server;
select lives_ok($t$ do $b$ begin
  for i in 1..40 loop
    insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('sr-user', 'sr_agent', 'srv' || i, '{"relayedBy": "notifier", "body": {}}', 'notifier');
  end loop; end $b$ $t$, 'S7: the server isn''t limited by device buckets');
reset role;

-- Coalesced session_events broadcasts: at most N pointers per second per session.
select pg_temp.as_device('sr-user', 'sr_agent', 'agent');
select lives_ok($t$ do $b$ begin
  for i in 1..25 loop
    insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
    values ('sr-user', 'sr_s1', 'ev' || i, 'sr_agent', i, now(), 'tool.started', '{}');
  end loop; end $b$ $t$, 'S7: an agent writes 25 events in a burst');
select pg_temp.logout();
select ok(pg_temp.sent('chalito:device:sr_phone', 'session_events') <= 2 * chalito_private.event_broadcasts_per_second(),
  'S7: the phone gets at most N pointers per second, not 25');
update chalito_private.event_gates set dirty = true, window_start = clock_timestamp() - interval '2 seconds'
  where owner = 'sr-user' and sid = 'sr_s1';
select chalito_private.flush_coalesced_events();
select is(pg_temp.sent('chalito:device:sr_phone', 'session_events', 'coalesced'), 1,
  'S7: the flush sends one coalesced pointer');
select is((select (payload ->> 'rev')::bigint from realtime.messages
           where topic = 'chalito:device:sr_phone' and payload ->> 'op' = 'coalesced' and inserted_at >= now()),
  (select max(rev) from chalito.session_events where sid = 'sr_s1'), 'S7: carrying the newest rev');
select is((select count(*)::int from cron.job where jobname = 'chalito-flush-coalesced'), 1,
  'S7: the flush runs under pg_cron');

-- ================================================================ S8: the sid must be the writer's session
select pg_temp.as_device('sr-user', 'sr_agent2', 'agent');
select throws_ok($$insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
  values ('sr-user', 'sr_s1', 'x1', 'sr_agent2', 0, now(), 'x', '{}')$$, '42501', null,
  'S8: no events into another device''s session');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, expires_at) values ('sr-user', 'x2', 'sr_agent2', 'sr_s1', 'r', 'tool', 'LOW', 'local',
  false, '{}', now() + interval '5 minutes')$$, '42501', null, 'S8: no approvals under another device''s session');
select throws_ok($$insert into chalito.call_lines (owner, lid, notification_id, device_id, sid, line, expires_at)
  values ('sr-user', 'x3', 'n1', 'sr_agent2', 'sr_s1', 'Hola', now() + interval '5 minutes')$$, '42501', null,
  'S8: no call lines under another device''s session');
select lives_ok($$insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
  values ('sr-user', 'sr_s2', 'own1', 'sr_agent2', 0, now(), 'x', '{}')$$, 'S8: its own session is fine');

select * from finish();
rollback;
