-- ADR 0031 §5: routing rules live in the owner's settings (`prefs.routing`, no migration). The owner's
-- clients and web session save and read them; the 4 KB prefs cap holds; nobody else sees them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.as_user(owner text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', owner, 'app_metadata', '{"provider": "email"}'::jsonb)) $$;

insert into chalito.tenants (id) values ('rr-a'), ('rr-b');
insert into chalito.users (id, tenant_id) values ('rr-a', 'rr-a'), ('rr-b', 'rr-b');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('rr-a', 'rr_a_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('rr_a_phone')::uuid),
  ('rr-b', 'rr_b_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('rr_b_phone')::uuid);

select pg_temp.as_device('rr-a', 'rr_a_phone', 'client');
select lives_ok($$select chalito.update_my_settings('{"prefs": {"onboarded_at": "2026-10-21T00:00:00Z"}}')$$,
  'another pref is already there');
select lives_ok($$select chalito.update_my_settings(jsonb_build_object('prefs', jsonb_build_object('routing',
  '{"v": 1, "rules": [{"workspaceLabel": "chalito", "appId": "codex", "devices": ["rr_a_home"]}], "fallback": ["rr_a_office"]}'::jsonb)))$$,
  'a client saves routing rules');
select is(chalito.get_my_settings() -> 'prefs' -> 'routing' -> 'rules' -> 0 ->> 'appId', 'codex',
  'they read back as saved');
select is(chalito.get_my_settings() -> 'prefs' ->> 'onboarded_at', '2026-10-21T00:00:00Z',
  'saving them keeps the other prefs (shallow merge)');

-- The largest rules the client accepts (3000 bytes) still fit next to other prefs.
select lives_ok(format($$select chalito.update_my_settings(jsonb_build_object('prefs', jsonb_build_object('routing',
  jsonb_build_object('v', 1, 'rules', '[]'::jsonb, 'fallback', jsonb_build_array(%s)), 'pad', %L)))$$,
  (select string_agg(quote_literal(repeat('d', 120)), ',') from generate_series(1, 6)), repeat('x', 2200)),
  'rules at the client cap fit beside the other prefs');

select pg_temp.as_user('rr-a');
select ok(chalito.get_my_settings() -> 'prefs' ? 'routing', 'the owner''s web session reads them too');

select pg_temp.as_device('rr-b', 'rr_b_phone', 'client');
select ok(not coalesce(chalito.get_my_settings() -> 'prefs' ? 'routing', false), 'another owner never sees them');

select * from finish();
rollback;
