-- Migration 003700: the room owner removes a member. Owner only, never itself; like a leave, the
-- member's keys go, the room needs a new epoch and the removed member's devices are told.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

grant usage on schema extensions to chalito_server, chalito_gateway;

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
create function pg_temp.sent(p_topic text, p_op text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'op' = p_op and inserted_at >= now() $$;
create function pg_temp.wrapped(devices text[]) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(d, repeat('k', 107)), '{}') from unnest(devices) d $$;

insert into chalito.tenants (id) values ('rm-own'), ('rm-a'), ('rm-b'), ('rm-out');
insert into chalito.users (id, tenant_id) values ('rm-own', 'rm-own'), ('rm-a', 'rm-a'), ('rm-b', 'rm-b'), ('rm-out', 'rm-out');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('rm-own', 'rm_own_phone', 'client', 'phone', 'ios', 'P', 'p', 'p', 'f', 'first_client', md5('rm_own_phone')::uuid),
  ('rm-a', 'rm_a_phone', 'client', 'phone', 'ios', 'A', 'p', 'p', 'f', 'first_client', md5('rm_a_phone')::uuid),
  ('rm-b', 'rm_b_phone', 'client', 'phone', 'ios', 'B', 'p', 'p', 'f', 'first_client', md5('rm_b_phone')::uuid),
  ('rm-out', 'rm_out_phone', 'client', 'phone', 'ios', 'O', 'p', 'p', 'f', 'first_client', md5('rm_out_phone')::uuid);
insert into chalito.companions (owner, companion_id, name) values
  ('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'Dueña'), ('rm-a', 'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb', 'A'),
  ('rm-b', 'chl_rmcccccccccccccccccccccccc', 'B'), ('rm-out', 'chl_rmdddddddddddddddddddddddd', 'Fuera');

set local role chalito_server;
select chalito_private.room_create('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1', 'family', 'Familia',
  pg_temp.wrapped(array['rm_own_phone']), 5);
select chalito_private.room_invite('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1', 'rm_inv1', repeat('a', 64), repeat('b', 64), 2,
  now() + interval '7 days');
select chalito_private.room_join('rm-a', 'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb', repeat('b', 64), 5);
select chalito_private.room_join('rm-b', 'chl_rmcccccccccccccccccccccccc', repeat('b', 64), 5);
select chalito_private.room_wrap_keys('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1', 'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb', 1,
  pg_temp.wrapped(array['rm_a_phone']));

-- ---------------------------------------------------------------- refusals
select throws_ok($$select chalito_private.room_remove_member('rm-a', 'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb', 'rm_r1',
  'chl_rmcccccccccccccccccccccccc')$$, '42501', null, 'remove: a member can''t remove another member');
select throws_ok($$select chalito_private.room_remove_member('rm-out', 'chl_rmdddddddddddddddddddddddd', 'rm_r1',
  'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb')$$, '42501', null, 'remove: nor someone outside the room');
select throws_ok($$select chalito_private.room_remove_member('rm-a', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1',
  'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb')$$, '42501', null, 'remove: nor someone acting as a companion that isn''t theirs');
select throws_ok($$select chalito_private.room_remove_member('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1',
  'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa')$$, '22023', null, 'remove: the owner can''t remove itself (it dissolves)');
select throws_ok($$select chalito_private.room_remove_member('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1',
  'chl_rmdddddddddddddddddddddddd')$$, 'PT404', null, 'remove: the target must be a member');
select is((select needs_rotation from chalito.rooms where room_id = 'rm_r1'), false, 'remove: refusals change nothing');

-- ---------------------------------------------------------------- the removal
select lives_ok($$select chalito_private.room_remove_member('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1',
  'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb')$$, 'remove: the owner removes a member');
reset role;
select is((select count(*)::int from chalito.room_members where room_id = 'rm_r1' and companion_id = 'chl_rmbbbbbbbbbbbbbbbbbbbbbbbb'),
  0, 'remove: the membership is gone');
select is((select count(*)::int from chalito.room_member_keys where room_id = 'rm_r1' and device_id = 'rm_a_phone'),
  0, 'remove: and its sealed keys with it');
select is((select needs_rotation from chalito.rooms where room_id = 'rm_r1'), true, 'remove: the room needs a new key epoch');
select is(pg_temp.sent('chalito:device:rm_a_phone', 'kicked'), 1, 'remove: the removed member''s device is told');

set local role chalito_server;
select throws_ok($$select chalito_private.room_post('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1', 'rm_e1', '{}', 'notice',
  'low', jsonb_build_object('alg', 'xchacha20poly1305', 'nonce', repeat('n', 32), 'ct', 'x', 'epoch', 1), 1)$$,
  'PT409', null, 'remove: no posts until the key rotates');
reset role;

select pg_temp.as_device('rm-own', 'rm_own_phone', 'client');
select throws_ok($$select chalito_private.room_remove_member('rm-own', 'chl_rmaaaaaaaaaaaaaaaaaaaaaaaa', 'rm_r1',
  'chl_rmcccccccccccccccccccccccc')$$, '42501', null, 'remove: clients can''t call the function directly (only the api)');
select pg_temp.logout();

select * from finish();
rollback;
