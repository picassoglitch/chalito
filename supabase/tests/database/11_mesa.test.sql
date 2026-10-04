-- M9 Mesa (migration 001900): the owner's devices read their Mesas and turns under RLS; only the
-- orchestrator (chalito_server) writes them, and only `doc` on mesas; clients get pointers.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

grant usage on schema extensions to chalito_server;

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

insert into chalito.tenants (id) values ('ms-user'), ('ms-other');
insert into chalito.users (id, tenant_id) values ('ms-user', 'ms-user'), ('ms-other', 'ms-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('ms-user', 'ms_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('ms_phone')::uuid),
  ('ms-user', 'ms_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('ms_agent')::uuid),
  ('ms-other', 'ms_x', 'client', 'phone', 'ios', 'X', 'p', 'p', 'f', 'first_client', md5('ms_x')::uuid);

-- ---------------------------------------------------------------- the orchestrator writes
set local role chalito_server;
select lives_ok($$insert into chalito.mesas (owner, mid, doc) values ('ms-user', 'm1', '{"kind": "mesa", "status": "open"}')$$,
  'orchestrator: creates a Mesa');
select lives_ok($$insert into chalito.mesa_turns (owner, mid, tid, doc) values ('ms-user', 'm1', 't1', '{"outCt": {}}')$$,
  'orchestrator: writes a turn');
select lives_ok($$update chalito.mesas set doc = jsonb_set(doc, '{status}', '"budget_reached"') where mid = 'm1'$$,
  'orchestrator: updates the Mesa''s counters and status');
select throws_ok($$update chalito.mesas set owner = 'ms-other' where mid = 'm1'$$, '42501', null,
  'orchestrator: but nothing else on the row');
select throws_ok($$update chalito.mesa_turns set doc = '{}' where tid = 't1'$$, '42501', null,
  'orchestrator: turns are append-only');
reset role;

select is(pg_temp.sent('chalito:device:ms_phone', 'mesa_turns'), 1, 'realtime: the phone gets a pointer to the turn');
select is(pg_temp.sent('chalito:device:ms_agent', 'mesa_turns'), 0, 'realtime: agents don''t (clients only)');
select is((select payload -> 'key' from realtime.messages where topic = 'chalito:device:ms_phone'
           and payload ->> 'table' = 'mesa_turns' order by inserted_at desc limit 1),
  '{"mid": "m1", "tid": "t1"}'::jsonb, 'realtime: the pointer carries only ids');

-- ---------------------------------------------------------------- the owner's devices read
select pg_temp.as_device('ms-user', 'ms_phone', 'client');
select is((select count(*)::int from chalito.mesa_turns where mid = 'm1'), 1, 'read: the owner''s phone reads the turns');
select is((select doc ->> 'status' from chalito.mesas where mid = 'm1'), 'budget_reached', 'read: and the Mesa');
select throws_ok($$insert into chalito.mesa_turns (owner, mid, tid, doc) values ('ms-user', 'm1', 't2', '{}')$$, '42501', null,
  'write: a client can''t write turns directly (only through the orchestrator)');
select throws_ok($$update chalito.mesas set doc = '{}' where mid = 'm1'$$, '42501', null,
  'write: nor change a Mesa''s budget or counters');
select pg_temp.as_device('ms-other', 'ms_x', 'client');
select is((select count(*)::int from chalito.mesa_turns), 0, 'read: other accounts see nothing');
select pg_temp.logout();

update chalito.devices set revoked = true where device_id = 'ms_phone';
select pg_temp.as_device('ms-user', 'ms_phone', 'client');
select is((select count(*)::int from chalito.mesa_turns), 0, 'read: a revoked device sees nothing');
select pg_temp.logout();

select * from finish();
rollback;
