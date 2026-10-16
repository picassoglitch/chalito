-- Migration 20261016000100: hand-off pairing (ADR 0028 §3–§4). The network record of a pairing
-- code is server-only (never the pairing watch token, a device or anon), lives only while the code
-- is open (dropped on claim, on decline, with the code, and by the 24-hour sweep), and a declined
-- code is visible to its watcher as `cancelled`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_pairing(code text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5('watch:' || code)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('role', 'pairing', 'pairing_code', code)))) $$;
create function pg_temp.as_agent(owner text, device text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'provider', 'chalito', 'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', 'agent')))) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into chalito.tenants (id) values ('ho-a');
insert into chalito.users (id, tenant_id) values ('ho-a', 'ho-a');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values ('ho-a', 'ho_desk', 'agent', 'desktop', 'linux', 'Desk', 'pk_desk', 'p', 'f', 'pairing', md5('ho_desk')::uuid, false);

insert into chalito.pairing_codes (code_id, short_code_hash, glyph, agent_device_id, kind, platform, expires_at, watch_auth_user_id)
values
  ('ho_open1', repeat('1', 64), '{}', 'ho_new1', 'desktop', 'macos', now() + interval '5 minutes', md5('watch:ho_open1')::uuid),
  ('ho_claim', repeat('2', 64), '{}', 'ho_new2', 'desktop', 'macos', now() + interval '5 minutes', md5('watch:ho_claim')::uuid),
  ('ho_decl1', repeat('3', 64), '{}', 'ho_new3', 'laptop', 'windows', now() + interval '5 minutes', md5('watch:ho_decl1')::uuid),
  ('ho_gone1', repeat('4', 64), '{}', 'ho_new4', 'desktop', 'linux', now() + interval '5 minutes', md5('watch:ho_gone1')::uuid),
  ('ho_old01', repeat('5', 64), '{}', 'ho_new5', 'desktop', 'linux', now() + interval '5 minutes', md5('watch:ho_old01')::uuid),
  ('ho_late1', repeat('6', 64), '{}', 'ho_new6', 'desktop', 'linux', now() + interval '5 minutes', md5('watch:ho_late1')::uuid);

-- ================================================================ the server writes it
set local role chalito_server;
select lives_ok($$insert into chalito_private.pairing_code_networks (code_id, family, net_hash, city, expires_at)
  select code_id, 4, repeat('a', 64), 'Guadalajara', expires_at from chalito.pairing_codes
  where code_id in ('ho_open1', 'ho_claim', 'ho_decl1', 'ho_gone1', 'ho_late1')$$,
  'chalito_server records the network of open codes');
select is((select count(*)::int from chalito_private.pairing_code_networks where code_id like 'ho_%'), 5,
  'chalito_server reads them back');
reset role;
select throws_ok($$insert into chalito_private.pairing_code_networks (code_id, family, net_hash, expires_at)
  values ('ho_old01', 4, '1.2.3.4', now())$$, '23514', null, 'only a hex hash is stored, never an address');
select throws_ok($$insert into chalito_private.pairing_code_networks (code_id, family, net_hash, created_at, expires_at)
  values ('ho_old01', 4, repeat('b', 64), now(), now() + interval '25 hours')$$, '23514', null,
  'a record can''t be kept past 24 hours');
-- An old record (created more than 24 hours ago), for the sweep below.
insert into chalito_private.pairing_code_networks (code_id, family, net_hash, created_at, expires_at)
values ('ho_old01', 6, repeat('c', 64), now() - interval '25 hours', now() - interval '1 hour' - interval '1 second');

insert into chalito_private.pairing_code_viewers (code_id, owner, device_id)
values ('ho_open1', 'ho-a', 'ho_phone'), ('ho_claim', 'ho-a', 'ho_phone'), ('ho_decl1', 'ho-a', 'ho_phone'),
       ('ho_gone1', 'ho-a', 'ho_phone');
insert into chalito_private.pairing_code_viewers (code_id, owner, device_id, viewed_at)
values ('ho_late1', 'ho-a', 'ho_phone', now() - interval '25 hours');

select throws_ok($$insert into chalito_private.pairing_code_viewers (code_id, owner, device_id, nonce_hash)
  values ('ho_old01', 'ho-a', 'ho_x', repeat('d', 64))$$, '23514', null, 'a nonce always has an expiry');
select throws_ok($$insert into chalito_private.pairing_code_viewers (code_id, owner, device_id, nonce_hash, nonce_expires_at)
  values ('ho_old01', 'ho-a', 'ho_x', 'raw-nonce', now())$$, '23514', null, 'only a nonce hash is kept, never the nonce');
set local role chalito_server;
select lives_ok($$update chalito_private.pairing_code_viewers set typed = true,
  nonce_hash = repeat('e', 64), nonce_expires_at = now() + interval '2 minutes'
  where code_id = 'ho_open1'$$, 'chalito_server marks a typed code and issues a nonce');
reset role;

-- ================================================================ nobody else reads it
select pg_temp.as_pairing('ho_open1');
select is((select count(*)::int from chalito.pairing_codes where code_id = 'ho_open1'), 1,
  'the watch token still reads its own code');
select is((select cancelled from chalito.pairing_codes where code_id = 'ho_open1'), false,
  'a fresh code is not cancelled, and the watcher can see that column');
select throws_ok($$select 1 from chalito_private.pairing_code_networks$$, '42501', null,
  'the pairing watch token can''t read network records (THREAT_MODEL §5)');
select throws_ok($$select 1 from chalito_private.pairing_code_viewers$$, '42501', null,
  'nor who opened a code');
select pg_temp.as_agent('ho-a', 'ho_desk');
select throws_ok($$select 1 from chalito_private.pairing_code_networks$$, '42501', null,
  'an agent device can''t read them');
select throws_ok($$insert into chalito_private.pairing_code_viewers (code_id, owner, device_id)
  values ('ho_open1', 'ho-a', 'ho_desk')$$, '42501', null, 'a device can''t make itself a viewer');
select pg_temp.logout();
set local role anon;
select throws_ok($$select 1 from chalito_private.pairing_code_networks$$, '42501', null, 'anon can''t read them');
reset role;
select ok(not has_table_privilege('service_role', 'chalito_private.pairing_code_networks', 'select'),
  'service_role has no grant either');
select ok(not has_column_privilege('authenticated', 'chalito.pairing_codes', 'cancelled', 'update'),
  'clients can''t cancel or un-cancel a code directly (the api does it)');

-- ================================================================ retention
update chalito.pairing_codes set claimed = true, owner = 'ho-a' where code_id = 'ho_claim';
select ok(not exists (select 1 from chalito_private.pairing_code_networks where code_id = 'ho_claim'),
  'claiming a code drops its network record');
update chalito.pairing_codes set cancelled = true where code_id = 'ho_decl1';
select ok(not exists (select 1 from chalito_private.pairing_code_networks where code_id = 'ho_decl1'),
  'declining a code drops its network record');
select ok(not exists (select 1 from chalito_private.pairing_code_viewers where code_id in ('ho_claim', 'ho_decl1')),
  'claiming or declining drops who opened it too');
select is((select cancelled from chalito.pairing_codes where code_id = 'ho_decl1'), true, 'the code stays, marked cancelled');
delete from chalito.pairing_codes where code_id = 'ho_gone1';
select ok(not exists (select 1 from chalito_private.pairing_code_networks where code_id = 'ho_gone1'),
  'deleting the code (its expiry purge) drops the record with it');
update chalito_private.pairing_code_networks set expires_at = now() - interval '1 second' where code_id = 'ho_late1';
select is(chalito_private.purge_pairing_networks(), 2, 'the sweep removes the expired and the over-24-hour records');
select is((select array_agg(code_id order by code_id) from chalito_private.pairing_code_networks where code_id like 'ho_%'),
  array['ho_open1']::text[], 'an open code''s record is kept');
select is((select array_agg(code_id order by code_id) from chalito_private.pairing_code_viewers where code_id like 'ho_%'),
  array['ho_open1']::text[], 'the sweep keeps only an open code''s viewers (24 h at most)');
select is((select schedule from cron.job where jobname = 'chalito-purge-pairing-networks'), '*/5 * * * *',
  'the sweep runs every five minutes under pg_cron');
select ok(not has_function_privilege('authenticated', 'chalito_private.purge_pairing_networks()', 'execute'),
  'clients can''t run the sweep');

select * from finish();
rollback;
