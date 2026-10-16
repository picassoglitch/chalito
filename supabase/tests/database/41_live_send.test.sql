-- Migration 20261015000100: chalito.live_send, the fast live path (M16 A, ADR 0022 §1).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.sent(p_topic text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = 'live' and inserted_at >= now() $$;
create function pg_temp.ev(type text, sid text, device text, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'eid', md5(random()::text), 'sid', sid, 'deviceId', device, 'seq', 0,
    't', 0, 'urgency', 'low', 'type', type) || extra $$;

insert into chalito.tenants (id) values ('ls-user'), ('ls-other');
insert into chalito.users (id, tenant_id) values ('ls-user', 'ls-user'), ('ls-other', 'ls-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('ls-user',  'ls_phone',    'client', 'phone',   'ios',   'Phone',     'p', 'p', 'f', 'first_client', false),
  ('ls-user',  'ls_oldphone', 'client', 'phone',   'ios',   'Old phone', 'p', 'p', 'f', 'first_client', true),
  ('ls-user',  'ls_agent',    'agent',  'desktop', 'linux', 'Desk',      'p', 'p', 'f', 'pairing',      false),
  ('ls-user',  'ls_agent2',   'agent',  'desktop', 'linux', 'Desk 2',    'p', 'p', 'f', 'pairing',      false),
  ('ls-other', 'ls_ophone',   'client', 'phone',   'ios',   'Other',     'p', 'p', 'f', 'first_client', false);
alter table chalito.devices disable trigger devices_broadcast;
update chalito.devices set auth_user_id = md5(device_id)::uuid;
alter table chalito.devices enable trigger devices_broadcast;
insert into chalito.sessions (owner, sid, device_id) values ('ls-user', 'ls_s1', 'ls_agent'), ('ls-user', 'ls_s2', 'ls_agent2');

-- ---------------------------------------------------------------- who gets what
select pg_temp.as_device('ls-user', 'ls_agent', 'agent');
select is(chalito.live_send(jsonb_build_array(
  pg_temp.ev('message.assistant.delta', 'ls_s1', 'ls_agent', '{"mid": "m1", "n": 0, "ct": {"ct": "x"}}'),
  pg_temp.ev('terminal.output', 'ls_s1', 'ls_agent', '{"tid": "ls_s1", "dataCt": {"ct": "y"}}'),
  pg_temp.ev('screen.state', 'ls_s1', 'ls_agent', '{"state": "live", "mode": "view"}'))), 3,
  'an active agent sends a batch of sealed live-only events');
select pg_temp.logout();
select is(pg_temp.sent('chalito:device:ls_phone'), 1, 'one broadcast per batch reaches the owner''s client');
select is((select jsonb_array_length(payload -> 'events') from realtime.messages
           where topic = 'chalito:device:ls_phone' and payload ->> 'table' = 'live'), 3, 'with every event in order');
select is(pg_temp.sent('chalito:device:ls_agent'), 0, 'not to agents');
select is(pg_temp.sent('chalito:device:ls_oldphone'), 0, 'not to revoked clients');
select is(pg_temp.sent('chalito:device:ls_ophone'), 0, 'not to another owner''s devices');
select is((select count(*)::int from chalito.session_events where sid = 'ls_s1'), 0, 'nothing is stored');

-- ---------------------------------------------------------------- what is refused
select pg_temp.as_device('ls-user', 'ls_phone', 'client');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('terminal.output', 'ls_s1', 'ls_agent', '{"dataCt": {}}')))$$, '42501', null, 'clients may not send');
select pg_temp.logout();
select pg_temp.as_device('ls-user', 'ls_agent', 'agent');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('message.assistant', 'ls_s1', 'ls_agent', '{"ct": {}}')))$$, '22023', null, 'durable types are refused');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('screen.state', 'ls_s1', 'ls_agent', '{"state": "ended", "mode": "view"}')))$$, '22023', null,
  'a screen end stays a stored row');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('message.assistant.delta', 'ls_s1', 'ls_agent', '{"mid": "m", "n": 0, "text": "plain"}')))$$, '22023', null,
  'content must be sealed');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('terminal.output', 'ls_s2', 'ls_agent', '{"dataCt": {}}')))$$, '42501', null,
  'only for the caller''s own sessions');
select throws_ok($$select chalito.live_send(jsonb_build_array(
  pg_temp.ev('terminal.output', 'ls_s1', 'ls_agent2', '{"dataCt": {}}')))$$, '22023', null,
  'events must name the calling device');
select throws_ok($$select chalito.live_send((select jsonb_agg(pg_temp.ev('terminal.output', 'ls_s1', 'ls_agent',
  '{"dataCt": {}}')) from generate_series(1, 65)))$$, '22023', null, 'at most 64 per call');
select pg_temp.logout();

select * from finish();
rollback;
