-- Identity: the claim-source switch (default app_metadata = Supabase Auth user per device), the
-- auth-user binding, the aud fence, and the custom mode's issuer and namespaced-sub fences.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

create function pg_temp.jwt(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (jsonb_build_object('role', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.count(q text) returns integer language plpgsql as $$
declare n integer;
begin
  execute format('select count(*) from (%s) as q', q) into n;
  return n;
end $$;
-- A device token as Supabase Auth would issue it for the device's own auth user.
create function pg_temp.device_jwt(sub uuid, owner text, device text, chalito_role text) returns jsonb language sql as $$
  select jsonb_build_object('aud', 'authenticated', 'iss', 'http://127.0.0.1:54321/auth/v1', 'sub', sub,
    'app_metadata', jsonb_build_object('provider', 'chalito',
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role))) $$;

insert into chalito.tenants (id) values ('user-1');
insert into chalito.users (id, tenant_id) values ('user-1', 'user-1');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values ('user-1', 'phone1', 'client', 'phone', 'ios', 'Phone', 'ps', 'pb', 'fp', 'first_client', md5('phone1')::uuid);

-- ---------------------------------------------------------------- app_metadata (the default)
select is(chalito_private.claim_source(), 'app_metadata', 'switch: defaults to app_metadata (Supabase Auth user per device)');

select pg_temp.jwt(pg_temp.device_jwt(md5('phone1')::uuid, 'user-1', 'phone1', 'client'));
select is(chalito.jwt_owner(), 'user-1', 'app_metadata: owner from app_metadata.chalito');
select is(chalito.jwt_device_id(), 'phone1', 'app_metadata: device_id from app_metadata.chalito');
select is(chalito.jwt_role(), 'client', 'app_metadata: role from app_metadata.chalito');
select ok(chalito_private.device_ok(), 'app_metadata: device_ok() for the device''s own auth user');
select is(pg_temp.count('select 1 from chalito.devices'), 1, 'app_metadata: the device reads its owner''s rows');

-- S5: the same claims on any other auth user (e.g. written into app_metadata by hub code) are useless.
select pg_temp.jwt(pg_temp.device_jwt(md5('someone else')::uuid, 'user-1', 'phone1', 'client'));
select ok(not chalito_private.device_ok(), 'app_metadata: a different auth user with the same claims is not the device');
select is(pg_temp.count('select 1 from chalito.devices'), 0, 'app_metadata: and reads nothing');

-- A token for another audience is no Chalito principal at all.
select pg_temp.jwt(pg_temp.device_jwt(md5('phone1')::uuid, 'user-1', 'phone1', 'client') || '{"aud": "other"}');
select is(chalito.jwt_claims(), null, 'aud: other audiences are fenced out');

select pg_temp.jwt(pg_temp.device_jwt(md5('phone1')::uuid, 'user-1', 'phone1', 'agent'));
select ok(not chalito_private.device_ok(), 'device_ok: the token role must match the device role');
select pg_temp.jwt(pg_temp.device_jwt(md5('phone1')::uuid, 'user-1', 'phone1', 'admin'));
select is(chalito.jwt_role(), null, 'jwt_role: unknown roles are null');

-- The person's own hub account is the web ('user') session.
select pg_temp.jwt('{"aud": "authenticated", "sub": "user-1", "app_metadata": {"provider": "email"}}');
select is(chalito.jwt_role(), 'user', 'hub account: role user');
select is(chalito.jwt_owner(), 'user-1', 'hub account: owner is the hub uid');
select is(pg_temp.count('select 1 from chalito.devices'), 1, 'hub account: reads its own rows');
select pg_temp.jwt('{"aud": "authenticated", "sub": "user-1", "is_anonymous": true}');
select is(chalito.jwt_claims(), null, 'hub account: anonymous users are not');

-- Top-level and user_metadata claims are never Chalito claims in this mode.
select pg_temp.jwt('{"aud": "authenticated", "iss": "chalito", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_device_id(), null, 'app_metadata: top-level claims are ignored');
select is(pg_temp.count('select 1 from chalito.devices'), 0, 'app_metadata: and read nothing');
select pg_temp.jwt('{"aud": "authenticated", "sub": "x", "user_metadata": {"chalito": {"owner": "user-1", "device_id": "phone1", "role": "client"}}}');
select is(chalito.jwt_device_id(), null, 'app_metadata: user_metadata is never trusted');

-- ---------------------------------------------------------------- custom (behind the switch)
select pg_temp.logout();
create or replace function chalito_private.claim_source() returns text language sql immutable
  set search_path = '' as $$ select 'custom' $$;

select pg_temp.jwt('{"aud": "authenticated", "iss": "chalito", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), 'user-1', 'custom: top-level claims with iss = claim_issuer()');
select ok(chalito_private.device_ok(), 'custom: device_ok()');

-- S1: sub is namespaced, so a Chalito token never carries a hub uid.
select pg_temp.jwt('{"aud": "authenticated", "iss": "chalito", "sub": "user-1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_claims(), null, 'custom: a device token whose sub isn''t d_<device_id> is refused');
select pg_temp.jwt('{"aud": "authenticated", "iss": "chalito", "sub": "u_user-1", "owner": "user-1", "chalito_role": "user"}');
select is(chalito.jwt_role(), 'user', 'custom: a user token has sub u_<owner>');
select pg_temp.jwt('{"aud": "authenticated", "iss": "https://hub.supabase.co/auth/v1", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_claims(), null, 'custom: other issuers are fenced out');
select pg_temp.jwt('{"aud": "anon", "iss": "chalito", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_claims(), null, 'custom: the aud fence applies too');

-- S3: the expected issuer is configurable (e.g. a third-party issuer URL).
select pg_temp.logout();
create or replace function chalito_private.claim_issuer() returns text language sql immutable
  set search_path = '' as $$ select 'https://api.chalito.example' $$;
select pg_temp.jwt('{"aud": ["authenticated"], "iss": "https://api.chalito.example", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), 'user-1', 'custom: claim_issuer() can be a URL, and aud may be an array');
select pg_temp.jwt('{"aud": "authenticated", "iss": "chalito", "sub": "d_phone1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), null, 'custom: the old issuer is no longer accepted');
select pg_temp.logout();

select * from finish();
rollback;
