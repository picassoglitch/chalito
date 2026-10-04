-- companion_directory carries the avatar and equipped cosmetics for the room scene (migration
-- 20261004003040): kept in step by a trigger on chalito.companions, server-written only, and read
-- only by the owner's active devices and room co-members (R-L4).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
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

insert into chalito.tenants (id) values ('dc-mom'), ('dc-kid'), ('dc-x');
insert into chalito.users (id, tenant_id) values ('dc-mom', 'dc-mom'), ('dc-kid', 'dc-kid'), ('dc-x', 'dc-x');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values ('dc-mom', 'dc_mom_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('dc_mom_phone')::uuid, false),
       ('dc-mom', 'dc_mom_old', 'client', 'phone', 'ios', 'Old', 'p', 'p', 'f', 'first_client', md5('dc_mom_old')::uuid, true),
       ('dc-kid', 'dc_kid_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('dc_kid_phone')::uuid, false),
       ('dc-x', 'dc_x_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('dc_x_phone')::uuid, false);

-- ================================================================ the trigger keeps the row in step
insert into chalito.companions (owner, companion_id, name, avatar) values
  ('dc-mom', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Mamá', 'luna'),
  ('dc-kid', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'Hijo', 'bruno'),
  ('dc-x', 'chl_cccccccccccccccccccccccccc', 'Otro', 'tito');
select results_eq(
  $$select display_name, avatar_thumb, equipped from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$,
  $$values ('Mamá'::text, 'luna'::text, '{}'::text[])$$,
  'a new companion gets its directory row (name, avatar, nothing equipped)');

-- Equip and unequip as the store does (server-side update of companions.equipped).
set local role chalito_server;
update chalito.companions set equipped = '{"head": "viking_hat", "back": "star_cape"}'
  where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa';
reset role;
select is((select equipped from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
  '{star_cape,viking_hat}'::text[], 'equipping shows in the directory (ids, in slot order)');
set local role chalito_server;
update chalito.companions set equipped = equipped - 'head', avatar = 'canela', name = 'Mami', is_renamed = true
  where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa';
reset role;
select results_eq(
  $$select display_name, is_renamed, avatar_thumb, equipped from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$,
  $$values ('Mami'::text, true, 'canela'::text, '{star_cape}'::text[])$$,
  'unequip, avatar change and rename propagate');
select throws_ok($$update chalito.companion_directory set equipped = '{"Not An Id"}'
  where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$, '23514', null, 'equipped holds catalog-shaped ids only');

-- ================================================================ who reads it (R-L4 + rooms)
insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id)
values ('dc_room', 'family', 'Casa', 'dc-mom', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa');
insert into chalito.room_members (room_id, companion_id, uid, role)
values ('dc_room', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'dc-mom', 'owner'),
       ('dc_room', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'dc-kid', 'member');

select pg_temp.as_device('dc-mom', 'dc_mom_phone', 'client');
select is((select count(*)::int from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'), 1,
  'the owner''s active device reads its companion''s row');
select pg_temp.as_device('dc-mom', 'dc_mom_old', 'client');
select is((select count(*)::int from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'), 0,
  'a revoked device doesn''t (R-L4)');
select pg_temp.as_device('dc-kid', 'dc_kid_phone', 'client');
select results_eq(
  $$select avatar_thumb, equipped from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$,
  $$values ('canela'::text, '{star_cape}'::text[])$$,
  'a room co-member sees the avatar and what it wears');
select pg_temp.as_device('dc-x', 'dc_x_phone', 'client');
select is((select count(*)::int from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'), 0,
  'a non-member doesn''t');

-- ================================================================ server-written only
select pg_temp.as_device('dc-mom', 'dc_mom_phone', 'client');
select throws_ok($$insert into chalito.companion_directory (companion_id, owner, display_name)
  values ('chl_dddddddddddddddddddddddddd', 'dc-mom', 'X')$$, '42501', null, 'a client can''t insert into the directory');
select throws_ok($$update chalito.companion_directory set equipped = '{portal_swirl}'
  where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$, '42501', null, 'a client can''t edit the directory');
select throws_ok($$update chalito.companions set equipped = '{"aura": "sparkle_aura"}'
  where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$, '42501', null, 'a client can''t equip by writing companions.equipped');
select throws_ok($$select chalito_private.equipped_ids('{}')$$, '42501', null, 'a client can''t call the helper');
-- The owner's own avatar change (its column grant) still reaches the directory through the trigger.
select lives_ok($$update chalito.companions set avatar = 'nube' where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$,
  'the owner changes the avatar');
select pg_temp.logout();
select is((select avatar_thumb from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
  'nube', '…and the directory follows');

select * from finish();
rollback;
