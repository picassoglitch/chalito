-- Beta security review, rooms (migration 20261004002600): R-L4, R-L6.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);
grant usage on schema extensions to chalito_server;

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into chalito.tenants (id) values ('rr-mom');
insert into chalito.users (id, tenant_id) values ('rr-mom', 'rr-mom');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values ('rr-mom', 'rr_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('rr_phone')::uuid, false),
       ('rr-mom', 'rr_old', 'client', 'phone', 'ios', 'Old', 'p', 'p', 'f', 'first_client', md5('rr_old')::uuid, true);
insert into chalito.companions (owner, companion_id, name) values ('rr-mom', 'chl_dddddddddddddddddddddddddd', 'Mamá');
insert into chalito.companion_directory (companion_id, owner, display_name)
values ('chl_dddddddddddddddddddddddddd', 'rr-mom', 'Mamá');

-- ================================================================ R-L4
select pg_temp.as_device('rr-mom', 'rr_phone', 'client');
select is((select count(*)::int from chalito.companion_directory where owner = 'rr-mom'), 1,
  'R-L4: an active device reads its owner''s directory entry');
select pg_temp.as_device('rr-mom', 'rr_old', 'client');
select is((select count(*)::int from chalito.companion_directory where owner = 'rr-mom'), 0,
  'R-L4: a revoked device no longer does');
select pg_temp.logout();

-- ================================================================ R-L6
set local role chalito_server;
select chalito_private.room_create('rr-mom', 'chl_dddddddddddddddddddddddddd', 'rr_room', 'family', 'Casa',
  jsonb_build_object('rr_phone', repeat('k', 107)), 1);
select lives_ok($$select chalito_private.room_wrap_keys('rr-mom', 'chl_dddddddddddddddddddddddddd', 'rr_room',
  'chl_dddddddddddddddddddddddddd', 1, jsonb_build_object('rr_phone', repeat('x', 107)))$$,
  'R-L6: a conflicting re-wrap for the same epoch is accepted as a no-op');
reset role;
select is((select ct from chalito.room_member_keys where room_id = 'rr_room' and device_id = 'rr_phone' and epoch = 1),
  repeat('k', 107), 'R-L6: the installed key is never replaced');

select * from finish();
rollback;
