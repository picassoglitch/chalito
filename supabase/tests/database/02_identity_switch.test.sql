-- Identity: the claim-source switch (chalito_private.claim_source) and the issuer fence.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create function pg_temp.jwt(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
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

insert into chalito.tenants (id) values ('user-1');
insert into chalito.users (id, tenant_id) values ('user-1', 'user-1');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('user-1', 'phone1', 'client', 'phone', 'ios', 'Phone', 'ps', 'pb', 'fp', 'first_client');

-- ---------------------------------------------------------------- custom (the default)
select is(chalito_private.claim_source(), 'custom', 'switch: defaults to custom claims');

select pg_temp.jwt('{"iss": "chalito", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), 'user-1', 'custom: owner from the top-level claim');
select is(chalito.jwt_device_id(), 'phone1', 'custom: device_id from the top-level claim');
select is(chalito.jwt_role(), 'client', 'custom: chalito_role from the top-level claim');
select ok(chalito_private.device_ok(), 'custom: device_ok() for an active device of the owner');
select is(pg_temp.count('select 1 from chalito.devices'), 1, 'custom: the device reads its owner''s rows');

-- A hub session (Supabase Auth issuer) with the same claims is not a Chalito principal.
select pg_temp.jwt('{"iss": "https://hub.supabase.co/auth/v1", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), null, 'custom: other issuers are fenced out');
select is(pg_temp.count('select 1 from chalito.devices'), 0, 'custom: and read nothing');

-- A token claiming a role its device doesn't have, or an unknown role.
select pg_temp.jwt('{"iss": "chalito", "owner": "user-1", "device_id": "phone1", "chalito_role": "agent"}');
select ok(not chalito_private.device_ok(), 'device_ok: the token role must match the device role');
select pg_temp.jwt('{"iss": "chalito", "owner": "user-1", "chalito_role": "admin"}');
select is(chalito.jwt_role(), null, 'jwt_role: unknown roles are null');

-- ---------------------------------------------------------------- app_metadata
select pg_temp.logout();
create or replace function chalito_private.claim_source() returns text language sql immutable
  set search_path = '' as $$ select 'app_metadata' $$;

select pg_temp.jwt('{"iss": "https://hub.supabase.co/auth/v1", "sub": "00000000-0000-0000-0000-000000000001",
  "app_metadata": {"provider": "email", "chalito": {"owner": "user-1", "device_id": "phone1", "chalito_role": "client"}}}');
select is(chalito.jwt_owner(), 'user-1', 'app_metadata: owner from app_metadata.chalito');
select ok(chalito_private.device_ok(), 'app_metadata: device_ok()');
select is(pg_temp.count('select 1 from chalito.devices'), 1, 'app_metadata: the device reads its owner''s rows');

-- Top-level and user_metadata claims are ignored in this mode (users can edit user_metadata).
select pg_temp.jwt('{"iss": "chalito", "owner": "user-1", "device_id": "phone1", "chalito_role": "client"}');
select is(chalito.jwt_owner(), null, 'app_metadata: top-level claims are ignored');
select pg_temp.jwt('{"user_metadata": {"chalito": {"owner": "user-1", "device_id": "phone1", "chalito_role": "client"}}}');
select is(chalito.jwt_owner(), null, 'app_metadata: user_metadata is never trusted');
select is(pg_temp.count('select 1 from chalito.devices'), 0, 'app_metadata: and reads nothing');
select pg_temp.logout();

select * from finish();
rollback;
