-- Custom companions (migration 20261005000100): one creation in flight per owner, one free creation
-- in flight or succeeded per owner (a failed free attempt gives the credit back), server-written
-- only, owner-readable; companions.asset_id points only at the owner's own succeeded creation and
-- picking a roster avatar clears it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);
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

insert into chalito.tenants (id) values ('av-a'), ('av-b');
insert into chalito.users (id, tenant_id) values ('av-a', 'av-a'), ('av-b', 'av-b');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values ('av-a', 'av_a_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('av_a_phone')::uuid, false),
       ('av-b', 'av_b_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('av_b_phone')::uuid, false);
insert into chalito.companions (owner, companion_id, name, avatar) values
  ('av-a', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'A', 'luna'),
  ('av-b', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'B', 'tito');

set local role chalito_server;
-- ================================================================ free credit and one in flight
insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
values ('cr_a_free_attempt_01', 'av-a', 'aaaa000000000001', true, 'image/jpeg', now() + interval '30 minutes');
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, reservation_id, content_type, upload_deadline)
  values ('cr_a_second_000001', 'av-a', 'aaaa000000000002', false, gen_random_uuid(), 'image/png', now() + interval '30 minutes')$$,
  '23505', null, 'one creation in flight per owner');
update chalito.avatar_creations set status = 'failed', failure = 'refused' where creation_id = 'cr_a_free_attempt_01';
select lives_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_a_free_attempt_02', 'av-a', 'aaaa000000000003', true, 'image/jpeg', now() + interval '30 minutes')$$,
  'a failed free attempt gives the free credit back');
update chalito.avatar_creations set status = 'succeeded', manifest = '{"v": 1, "emotions": {"mode": "swap", "src": {}}}'
  where creation_id = 'cr_a_free_attempt_02';
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_a_free_attempt_03', 'av-a', 'aaaa000000000004', true, 'image/jpeg', now() + interval '30 minutes')$$,
  '23505', null, 'a succeeded free creation uses the credit up');
select lives_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, reservation_id, est_tokens, content_type, upload_deadline)
  values ('cr_a_paid_00000001', 'av-a', 'aaaa000000000005', false, gen_random_uuid(), 83750, 'image/webp', now() + interval '30 minutes')$$,
  'later creations are paid (with a hub reservation)');
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_b_paid_no_resv01', 'av-b', 'bbbb000000000001', false, 'image/jpeg', now() + interval '30 minutes')$$,
  '23514', null, 'a paid creation carries its reservation');
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_b_gif_0000000001', 'av-b', 'bbbb000000000002', true, 'image/gif', now() + interval '30 minutes')$$,
  '23514', null, 'photos only (PNG, JPEG, WebP)');
select throws_ok($$update chalito.avatar_creations set status = 'succeeded' where creation_id = 'cr_a_paid_00000001'$$,
  '23514', null, 'a success has its card manifest');
insert into chalito.avatar_creations (creation_id, owner, asset_id, free, status, manifest, content_type, upload_deadline)
values ('cr_b_free_done_0001', 'av-b', 'bbbb000000000003', true, 'succeeded', '{"v": 1}', 'image/jpeg', now());

-- ================================================================ the companion's card
select lives_ok($$update chalito.companions set asset_id = 'aaaa000000000003', expression_map = '{"mode": "swap"}'
  where owner = 'av-a'$$, 'the server points the companion at its own succeeded creation');
select throws_ok($$update chalito.companions set asset_id = 'bbbb000000000003' where owner = 'av-a'$$,
  '23514', null, 'never at another owner''s creation');
select throws_ok($$update chalito.companions set asset_id = 'aaaa000000000005' where owner = 'av-a'$$,
  '23514', null, 'nor at an unfinished one');
reset role;

-- ================================================================ owner-readable, server-written
select pg_temp.as_device('av-a', 'av_a_phone', 'client');
select is((select count(*)::int from chalito.avatar_creations), 3, 'the owner reads its own creations only');
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_a_client_000001', 'av-a', 'aaaa000000000009', true, 'image/jpeg', now())$$,
  '42501', null, 'a client can''t start a creation by writing the table');
select throws_ok($$update chalito.companions set asset_id = null where owner = 'av-a'$$,
  '42501', null, 'a client can''t write companions.asset_id');
select lives_ok($$update chalito.companions set avatar = 'nube' where owner = 'av-a'$$,
  'the owner picks a roster avatar');
select pg_temp.logout();
select results_eq($$select asset_id, expression_map from chalito.companions where owner = 'av-a'$$,
  $$values (null::text, null::jsonb)$$, '…which clears the custom card');

select * from finish();
rollback;
