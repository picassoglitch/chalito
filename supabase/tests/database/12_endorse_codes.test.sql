-- Endorsement handoff codes (migration 20261004002200): server-only table, the waiting device's
-- scoped watcher, the pointer broadcast and the TTL sweep.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

grant usage on schema extensions to chalito_server;

create function pg_temp.login(claims jsonb, topic text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  perform set_config('realtime.topic', coalesce(topic, ''), true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('realtime.topic', '', true);
end $$;
create function pg_temp.sent(p_topic text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = 'endorse_codes' and inserted_at >= now() $$;
create function pg_temp.watcher(code text, sub uuid) returns jsonb language sql as $$
  select jsonb_build_object('sub', sub,
    'app_metadata', jsonb_build_object('chalito', jsonb_build_object('role', 'pairing', 'pairing_code', code))) $$;

insert into chalito.tenants (id) values ('ec-user'), ('ec-other');
insert into chalito.users (id, tenant_id) values ('ec-user', 'ec-user'), ('ec-other', 'ec-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked, auth_user_id)
values ('ec-user', 'ec_phone', 'client', 'phone', 'ios', 'Phone', 'ps', 'pb', 'fp', 'first_client', false, md5('ec_phone')::uuid);

set local role chalito_server;
insert into chalito.endorse_codes (code_id, short_code_hash, owner, new_device_id, registration, expires_at, watch_auth_user_id)
values ('ec_code_live_000000000', repeat('a', 64), 'ec-user', 'ec_new', '{"body": {}}', now() + interval '5 minutes', md5('watch:ec_live')::uuid),
       ('ec_code_old_0000000000', repeat('b', 64), 'ec-user', 'ec_new2', '{"body": {}}', now() - interval '1 minute', md5('watch:ec_old')::uuid);
select is((select count(*)::int from chalito.endorse_codes where owner = 'ec-user'), 2, 'server: chalito_server writes and reads codes');
select throws_ok($$insert into chalito.endorse_codes (code_id, short_code_hash, owner, new_device_id, registration, expires_at)
  values ('ec_dup', repeat('a', 64), 'ec-user', 'x', '{}', now() + interval '1 minute')$$, '23505', null,
  'server: short code hashes are unique');
select throws_ok($$insert into chalito.endorse_codes (code_id, short_code_hash, owner, new_device_id, registration, expires_at)
  values ('ec_bad', 'NOT-A-HASH', 'ec-user', 'x', '{}', now() + interval '1 minute')$$, '23514', null,
  'server: only a sha-256 hex digest is stored, never the short code');
select throws_ok($$update chalito.endorse_codes set taken_at = now() where code_id = 'ec_code_live_000000000'$$, '23514', null,
  'server: nothing can be taken before it is endorsed');
reset role;

-- ---------------------------------------------------------------- nobody else reads the table
select pg_temp.login(jsonb_build_object('sub', md5('ec_phone')::uuid, 'app_metadata', jsonb_build_object(
  'chalito', jsonb_build_object('owner', 'ec-user', 'device_id', 'ec_phone', 'role', 'client'))), null);
select throws_ok($$select 1 from chalito.endorse_codes$$, '42501', null, 'rls: a trusted client can''t read codes directly');
select throws_ok($$update chalito.endorse_codes set endorsement = '{}'$$, '42501', null, 'rls: nor write an endorsement');
select pg_temp.login(pg_temp.watcher('ec_code_live_000000000', md5('watch:ec_live')::uuid), null);
select throws_ok($$select 1 from chalito.endorse_codes$$, '42501', null, 'rls: the watcher can''t read the table either');
select pg_temp.logout();

-- ---------------------------------------------------------------- the pointer
set local role chalito_server;
update chalito.endorse_codes set watch_auth_user_id = watch_auth_user_id where code_id = 'ec_code_live_000000000';
reset role;
select is(pg_temp.sent('chalito:pairing:ec_code_live_000000000'), 0, 'broadcast: bookkeeping updates send nothing');
set local role chalito_server;
update chalito.endorse_codes set endorsement = '{"ctx": "chalito.endorsement.v1"}', endorsed_by_device_id = 'ec_phone',
  endorsed_at = now() where code_id = 'ec_code_live_000000000';
reset role;
select is(pg_temp.sent('chalito:pairing:ec_code_live_000000000'), 1, 'broadcast: the waiting device is told once it is endorsed');
set local role chalito_server;
reset role;
select is((select payload -> 'key' from realtime.messages where topic = 'chalito:pairing:ec_code_live_000000000'
  and payload ->> 'table' = 'endorse_codes'), '{"code_id": "ec_code_live_000000000"}'::jsonb,
  'broadcast: a pointer, never the endorsement');
set local role chalito_server;
update chalito.endorse_codes set taken_at = now() where code_id = 'ec_code_live_000000000';
reset role;
select is(pg_temp.sent('chalito:pairing:ec_code_live_000000000'), 1, 'broadcast: taking it sends nothing more');
set local role chalito_server;
reset role;

-- ---------------------------------------------------------------- the watcher's join
select pg_temp.login(pg_temp.watcher('ec_code_live_000000000', md5('watch:ec_live')::uuid), 'chalito:pairing:ec_code_live_000000000');
select ok(chalito_private.realtime_topic_ok('chalito:pairing:ec_code_live_000000000'), 'join: the watcher may join its code''s topic');
select ok((select count(*) from realtime.messages where topic = 'chalito:pairing:ec_code_live_000000000') > 0,
  'join: and receives the pointer');
select pg_temp.login(pg_temp.watcher('ec_code_live_000000000', md5('someone-else')::uuid), 'chalito:pairing:ec_code_live_000000000');
select ok(not chalito_private.realtime_topic_ok('chalito:pairing:ec_code_live_000000000'),
  'join: only the code''s own watcher user (sub must match)');
select pg_temp.login(pg_temp.watcher('ec_code_old_0000000000', md5('watch:ec_old')::uuid), 'chalito:pairing:ec_code_old_0000000000');
select ok(not chalito_private.realtime_topic_ok('chalito:pairing:ec_code_old_0000000000'), 'join: not after the code expired');
select pg_temp.login(pg_temp.watcher('ec_code_live_000000000', md5('watch:ec_live')::uuid), 'chalito:device:ec_phone');
select ok(not chalito_private.realtime_topic_ok('chalito:device:ec_phone'), 'join: never a device topic');
select pg_temp.logout();

-- ---------------------------------------------------------------- TTL
select chalito_private.purge_expired();
select is((select array_agg(code_id order by code_id) from chalito.endorse_codes where owner = 'ec-user'),
  array['ec_code_live_000000000']::text[], 'ttl: expired codes are swept with the other TTL rows');

select * from finish();
rollback;
