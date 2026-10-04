-- Realtime broadcasts (per-device private topics, RLS on realtime.messages) and TTL cleanup.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

create function pg_temp.login(claims jsonb, topic text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated', 'iss', 'chalito') || claims)::text, true);
  perform set_config('realtime.topic', coalesce(topic, ''), true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text, topic text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('owner', owner, 'device_id', device, 'chalito_role', chalito_role), topic) $$;
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
-- Messages sent to a topic during this test (the realtime table may hold other traffic).
create function pg_temp.sent(p_topic text, p_table text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = p_table and inserted_at >= now() $$;

insert into chalito.tenants (id) values ('user-1');
insert into chalito.users (id, tenant_id) values ('user-1', 'user-1');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('user-1', 'rt_phone',    'client', 'phone',   'ios',   'Phone',     'ps', 'pb', 'fp', 'first_client', false),
  ('user-1', 'rt_agent',    'agent',  'desktop', 'linux', 'Desk',      'ps', 'pb', 'fp', 'pairing',      false),
  ('user-1', 'rt_oldphone', 'client', 'phone',   'ios',   'Old phone', 'ps', 'pb', 'fp', 'first_client', true);
insert into chalito.pairing_codes (code_id, short_code_hash, glyph, agent_device_id, kind, platform, expires_at)
values ('rt_code', repeat('d', 64), '{}', 'rt_new', 'desktop', 'linux', now() + interval '5 minutes');

-- ---------------------------------------------------------------- who gets what
insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
values ('user-1', 'rt_agent', 'rt_c1', '{"ctx": "chalito.command.v1"}', 'rt_phone');
select is(pg_temp.sent('device:rt_agent', 'commands'), 1, 'broadcast: a command goes to its target agent');
select is(pg_temp.sent('device:rt_phone', 'commands'), 0, 'broadcast: and to no one else');
select is((select payload -> 'key' from realtime.messages where topic = 'device:rt_agent' and payload ->> 'table' = 'commands'),
  '{"id": "rt_c1", "target_device_id": "rt_agent"}'::jsonb, 'broadcast: the payload is a pointer, not the envelope');
select ok((select (payload ->> 'cursor')::bigint from realtime.messages where topic = 'device:rt_agent'
  and payload ->> 'table' = 'commands') is not null, 'broadcast: the payload carries the resync cursor');

insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required,
  details_ct, expires_at)
values ('user-1', 'rt_a1', 'rt_agent', 's1', 'r1', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes');
select is(pg_temp.sent('device:rt_phone', 'approvals'), 1, 'broadcast: approvals reach the clients');
select is(pg_temp.sent('device:rt_agent', 'approvals'), 1, 'broadcast: and the agents');
select is(pg_temp.sent('device:rt_oldphone', 'approvals'), 0, 'broadcast: never a revoked device');

insert into chalito.sessions (owner, sid, device_id) values ('user-1', 'rt_s1', 'rt_agent');
select is(pg_temp.sent('device:rt_phone', 'sessions'), 1, 'broadcast: session cards reach clients');
select is(pg_temp.sent('device:rt_agent', 'sessions'), 0, 'broadcast: not back to agents');

update chalito.devices set revoked = true where device_id = 'rt_phone';
select is(pg_temp.sent('device:rt_phone', 'devices'), 0, 'broadcast: a device revoked by the update is not told');
select is(pg_temp.sent('device:rt_agent', 'devices'), 1, 'broadcast: the other devices are');
update chalito.devices set revoked = false where device_id = 'rt_phone';

update chalito.pairing_codes set claimed = true, owner = 'user-1' where code_id = 'rt_code';
select is(pg_temp.sent('pairing:rt_code', 'pairing_codes'), 1, 'broadcast: the pairing watcher is told when its code is claimed');

-- ---------------------------------------------------------------- realtime.messages RLS (join authorization)
select pg_temp.as_device('user-1', 'rt_agent', 'agent', 'device:rt_agent');
select ok(pg_temp.count($$select 1 from realtime.messages where topic = 'device:rt_agent'$$) > 0,
  'join: a device may receive on its own topic');
select pg_temp.as_device('user-1', 'rt_agent', 'agent', 'device:rt_phone');
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'device:rt_phone'$$), 0,
  'join: not on another device''s topic');
select pg_temp.as_device('user-1', 'rt_oldphone', 'client', 'device:rt_oldphone');
select is(pg_temp.count($$select 1 from realtime.messages$$), 0, 'join: a revoked device receives nothing');
select pg_temp.login('{"chalito_role": "pairing", "pairing_code": "rt_code"}', 'pairing:rt_code');
select ok(pg_temp.count($$select 1 from realtime.messages where topic = 'pairing:rt_code'$$) > 0,
  'join: the pairing watcher receives on its code''s topic');
select pg_temp.as_device('user-1', 'rt_phone', 'client', 'device:rt_phone');
select throws_ok($$insert into realtime.messages (topic, extension, payload, event, private)
  values ('device:rt_agent', 'broadcast', '{"forged": true}', 'commands', true)$$, '42501', null,
  'join: clients can''t broadcast on chalito topics');
select pg_temp.logout();

-- ---------------------------------------------------------------- TTL
insert into chalito.commands (owner, target_device_id, id, env, from_device_id, expires_at)
values ('user-1', 'rt_agent', 'rt_old', '{"ctx": "chalito.command.v1"}', 'rt_phone', now() - interval '1 second');
insert into chalito_private.sso_tokens (sig_hash, expires_at)
values ('old', now() - interval '1 second'), ('live', now() + interval '1 minute');
select chalito_private.purge_expired();
select is((select count(*)::int from chalito.commands where id in ('rt_old', 'rt_c1')), 1,
  'ttl: expired commands are purged, live ones kept');
select is((select array_agg(sig_hash) from chalito_private.sso_tokens), array['live'],
  'ttl: expired sso tokens are purged');
select is((select count(*)::int from cron.job where jobname = 'chalito-purge-expired' and schedule = '* * * * *'), 1,
  'ttl: the purge runs every minute under pg_cron');

select * from finish();
rollback;
