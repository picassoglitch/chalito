-- Resync revisions (rev bumped on insert and update), session_merge, presence-only device updates.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

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
create function pg_temp.sent(p_topic text, p_table text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = p_table and inserted_at >= now() $$;

insert into chalito.tenants (id) values ('rv-user');
insert into chalito.users (id, tenant_id) values ('rv-user', 'rv-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values
  ('rv-user', 'rv_phone',  'client', 'phone',   'ios',   'Phone', 'ps', 'pb', 'fp', 'first_client'),
  ('rv-user', 'rv_agent',  'agent',  'desktop', 'linux', 'Desk',  'ps', 'pb', 'fp', 'pairing'),
  ('rv-user', 'rv_agent2', 'agent',  'laptop',  'macos', 'Lap',   'ps', 'pb', 'fp', 'pairing');
-- Fixture setup, not a device change anyone should be told about.
alter table chalito.devices disable trigger devices_broadcast;
update chalito.devices set auth_user_id = md5(device_id)::uuid;
alter table chalito.devices enable trigger devices_broadcast;
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required,
  details_ct, expires_at)
values
  ('rv-user', 'rv_a1', 'rv_agent', 's1', 'r1', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes'),
  ('rv-user', 'rv_a2', 'rv_agent', 's1', 'r2', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes');

-- ---------------------------------------------------------------- rev
create temp table mark as
  select max(rev) as rev, max(cursor) as cursor from chalito.approvals where owner = 'rv-user';
grant select on mark to authenticated;

select ok((select bool_and(rev is not null and rev > 0) from chalito.approvals where owner = 'rv-user'),
  'rev: set on insert');

-- An approval resolved "while the phone was offline": an update to an older row.
select pg_temp.as_device('rv-user', 'rv_agent', 'agent');
update chalito.approvals set status = 'approved', resolved_at = now(), reason = 'signed_allow' where aid = 'rv_a1';
select pg_temp.logout();

select ok((select rev from chalito.approvals where aid = 'rv_a1') > (select rev from mark),
  'rev: bumped on update, past every earlier revision');
select is((select array_agg(aid::text) from chalito.approvals where owner = 'rv-user' and rev > (select rev from mark)),
  array['rv_a1'], 'resync: rev > last finds the updated row');
select is((select count(*)::int from chalito.approvals where owner = 'rv-user' and cursor > (select cursor from mark)), 0,
  'resync: cursor > last alone would have missed it');
select is((select max((payload ->> 'rev')::bigint) from realtime.messages
           where topic = 'chalito:device:rv_phone' and payload ->> 'table' = 'approvals' and payload -> 'key' ->> 'aid' = 'rv_a1'),
  (select rev from chalito.approvals where aid = 'rv_a1'), 'pointer: carries the row''s rev');

select pg_temp.as_device('rv-user', 'rv_phone', 'client');
select throws_ok($$update chalito.approvals set rev = 1 where aid = 'rv_a2'$$, '42501', null,
  'rev: devices can''t write it');
select pg_temp.logout();

select ok((select rev from chalito.devices where device_id = 'rv_phone') > 0, 'rev: devices have it too');

-- ---------------------------------------------------------------- session_merge
select pg_temp.as_device('rv-user', 'rv_agent', 'agent');
select lives_ok($$select chalito.session_merge('rv_s1', '{"state": "running", "label": "api"}')$$,
  'merge: the first call creates the session');
select lives_ok($$select chalito.session_merge('rv_s1', '{"state": "idle", "lastEventSeq": 4}')$$,
  'merge: the next call merges into it');
select is((select doc from chalito.sessions where sid = 'rv_s1'),
  '{"state": "idle", "label": "api", "lastEventSeq": 4}'::jsonb, 'merge: a shallow merge, keys kept');
select is((select device_id::text from chalito.sessions where sid = 'rv_s1'), 'rv_agent', 'merge: owned by the calling agent');
select throws_ok($$select chalito.session_merge('rv_s1', '"nope"')$$, '22023', null, 'merge: the patch must be an object');

select pg_temp.as_device('rv-user', 'rv_agent2', 'agent');
select throws_ok($$select chalito.session_merge('rv_s1', '{"state": "hijacked"}')$$, '42501', null,
  'merge: another agent of the same owner can''t merge into it');
select pg_temp.as_device('rv-user', 'rv_phone', 'client');
select throws_ok($$select chalito.session_merge('rv_s2', '{"state": "running"}')$$, '42501', null,
  'merge: a client can''t create sessions');
select pg_temp.logout();
select is((select doc ->> 'state' from chalito.sessions where sid = 'rv_s1'), 'idle', 'merge: the row is untouched');

-- ---------------------------------------------------------------- presence-only device updates
select pg_temp.as_device('rv-user', 'rv_agent', 'agent');
update chalito.devices set last_seen_at = now(), presence = '{"state": "online"}' where device_id = 'rv_agent';
select pg_temp.logout();
select is(pg_temp.sent('chalito:device:rv_phone', 'devices'), 0, 'devices: a presence-only update is not broadcast');

select pg_temp.as_device('rv-user', 'rv_agent', 'agent');
update chalito.devices set policy_hash = 'cd', last_seen_at = now() where device_id = 'rv_agent';
select pg_temp.logout();
select is(pg_temp.sent('chalito:device:rv_phone', 'devices'), 1, 'devices: a policy change still is');

select * from finish();
rollback;
