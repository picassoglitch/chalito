-- devices.webauthn_binding and pairing_codes.claimer_webauthn_binding (migration 001300): readable by
-- the owner's principals (and the pairing watcher for its own code), written only by the api.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- pgTAP lives in `extensions`; let the server role call it inside this (rolled-back) test only.
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
create function pg_temp.affected(stmt text) returns integer language plpgsql as $$
declare n integer;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;

insert into chalito.tenants (id) values ('wb-user'), ('wb-other');
insert into chalito.users (id, tenant_id) values ('wb-user', 'wb-user'), ('wb-other', 'wb-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('wb-user', 'wb_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('wb_phone')::uuid),
  ('wb-user', 'wb_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('wb_agent')::uuid),
  ('wb-other', 'wb_x', 'client', 'phone', 'ios', 'X', 'p', 'p', 'f', 'first_client', md5('wb_x')::uuid);
insert into chalito.pairing_codes (code_id, short_code_hash, glyph, agent_device_id, kind, platform, expires_at, watch_auth_user_id)
values ('wb_code', repeat('f', 64), '{}', 'wb_new', 'desktop', 'linux', now() + interval '5 minutes', md5('watch:wb_code')::uuid);

-- ---------------------------------------------------------------- the api sets them
set local role chalito_server;
select lives_ok($$update chalito.devices set webauthn_binding = '{"ctx": "chalito.webauthn-binding.v1", "sig": "s"}'
  where device_id = 'wb_phone'$$, 'api: stores a device''s binding');
select lives_ok($$update chalito.pairing_codes set claimer_webauthn_binding = '{"ctx": "chalito.webauthn-binding.v1"}'
  where code_id = 'wb_code'$$, 'api: hands the claimer''s binding to the pairing code');
select throws_ok($$update chalito.devices set webauthn_binding = '"not an object"' where device_id = 'wb_phone'$$, '23514', null,
  'api: a binding is a JSON object');
reset role;

-- ---------------------------------------------------------------- reads
select pg_temp.as_device('wb-user', 'wb_agent', 'agent');
select is((select webauthn_binding ->> 'ctx' from chalito.devices where device_id = 'wb_phone'), 'chalito.webauthn-binding.v1',
  'read: the owner''s agent reads the phone''s binding');
select pg_temp.as_device('wb-other', 'wb_x', 'client');
select is((select count(*)::int from chalito.devices where webauthn_binding is not null), 0, 'read: other accounts don''t');
select pg_temp.login(jsonb_build_object('sub', md5('watch:wb_code')::uuid,
  'app_metadata', '{"chalito": {"role": "pairing", "pairing_code": "wb_code"}}'::jsonb));
select is((select claimer_webauthn_binding ->> 'ctx' from chalito.pairing_codes where code_id = 'wb_code'),
  'chalito.webauthn-binding.v1', 'read: the pairing watcher reads the claimer''s binding on its own code');

-- ---------------------------------------------------------------- clients can't write them
select pg_temp.as_device('wb-user', 'wb_phone', 'client');
select throws_ok($$update chalito.devices set webauthn_binding = '{}' where device_id = 'wb_phone'$$, '42501', null,
  'write: a client can''t set its binding directly (only via /v1/webauthn/register/bind)');
select pg_temp.as_device('wb-user', 'wb_agent', 'agent');
select throws_ok($$update chalito.devices set webauthn_binding = '{}' where device_id = 'wb_agent'$$, '42501', null,
  'write: nor can an agent, even on its own device row');
select throws_ok($$update chalito.pairing_codes set claimer_webauthn_binding = '{}' where code_id = 'wb_code'$$, '42501', null,
  'write: nobody but the api writes the claimer binding');
select is(pg_temp.affected($$update chalito.devices set last_seen_at = now() where device_id = 'wb_agent'$$), 1,
  'write: the agent''s own allowed columns still work');
select pg_temp.logout();

select * from finish();
rollback;
