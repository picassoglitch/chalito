-- "Eliminar mi personaje", migration 20261005000400: only a succeeded creation can be deleted and a
-- deleted one never comes back; deleting drops the manifest, stamps deleted_at and takes the card off
-- the companion that wears it (back to its roster avatar) in the same transaction; a deleted card
-- can't be worn again or handed out in a room; a deleted free creation still holds the free credit;
-- the free-creation markers are untouched.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
grant usage on schema extensions to chalito_server;

insert into chalito.tenants (id) values ('del-a'), ('del-b');
insert into chalito.users (id, tenant_id) values ('del-a', 'del-a'), ('del-b', 'del-b');
insert into chalito.companions (owner, companion_id, name, avatar) values
  ('del-a', 'chl_delaaaaaaaaaaaaaaaaaaaaaa', 'A', 'luna'),
  ('del-b', 'chl_delbbbbbbbbbbbbbbbbbbbbbb', 'B', 'tito');
insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id)
values ('room_del_test_0001', 'family', 'Casa', 'del-b', 'chl_delbbbbbbbbbbbbbbbbbbbbbb');
insert into chalito.room_members (room_id, companion_id, uid, role) values
  ('room_del_test_0001', 'chl_delbbbbbbbbbbbbbbbbbbbbbb', 'del-b', 'owner'),
  ('room_del_test_0001', 'chl_delaaaaaaaaaaaaaaaaaaaaaa', 'del-a', 'member');

set local role chalito_server;
-- A's free creation succeeds (leaving its markers) and is worn.
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, content_type, upload_deadline, free_markers)
values (true, '18_plus', now(), 'cr_del_a_free_0001', 'del-a', 'dela000000000001', true, 'image/jpeg',
        now() + interval '30 minutes', array[md5('del-uid') || md5('del-uid2')]);
update chalito.avatar_creations set status = 'succeeded',
  manifest = '{"v": 1, "emotions": {"mode": "swap", "src": {"neutral": "layer-neutral.webp"}}, "thumbs": {}}'
  where creation_id = 'cr_del_a_free_0001';
update chalito.companions set asset_id = 'dela000000000001',
  expression_map = '{"mode": "swap", "src": {"neutral": "layer-neutral.webp"}}' where owner = 'del-a';
select is((select count(*)::int from chalito_private.room_member_cards('del-b', 'room_del_test_0001')), 1,
  'before: the room hands out A''s card');

-- ================================================================ only from succeeded
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, reservation_id, content_type, upload_deadline)
values (true, '18_plus', now(), 'cr_del_b_flight001', 'del-b', 'delb000000000001', false, gen_random_uuid(), 'image/jpeg',
        now() + interval '30 minutes');
select throws_ok($$update chalito.avatar_creations set status = 'deleted' where creation_id = 'cr_del_b_flight001'$$,
  '23514', null, 'a creation in flight can''t be deleted');
update chalito.avatar_creations set status = 'failed', failure = 'refused' where creation_id = 'cr_del_b_flight001';
select throws_ok($$update chalito.avatar_creations set status = 'deleted', failure = null where creation_id = 'cr_del_b_flight001'$$,
  '23514', null, 'a failed creation can''t be deleted');
select throws_ok($$update chalito.avatar_creations set deleted_at = now() where creation_id = 'cr_del_b_flight001'$$,
  '23514', null, 'deleted_at only with status deleted');
select throws_ok($$update chalito.avatar_creations set files_deleted_at = now() where creation_id = 'cr_del_a_free_0001'$$,
  '23514', null, 'files_deleted_at only on a deleted creation');

-- ================================================================ delete
select lives_ok($$update chalito.avatar_creations set status = 'deleted' where creation_id = 'cr_del_a_free_0001'$$,
  'a succeeded creation can be deleted');
select results_eq($$select manifest is null, deleted_at is not null, files_deleted_at is null, free
  from chalito.avatar_creations where creation_id = 'cr_del_a_free_0001'$$,
  $$values (true, true, true, true)$$, 'the row stays (free, billing, audit) without its manifest');
select results_eq($$select avatar, asset_id, expression_map from chalito.companions where owner = 'del-a'$$,
  $$values ('luna'::text, null::text, null::jsonb)$$, 'the companion that wore it is back on its roster avatar');
select is((select count(*)::int from chalito_private.room_member_cards('del-b', 'room_del_test_0001')), 0,
  'the room no longer hands it out');
select throws_ok($$update chalito.companions set asset_id = 'dela000000000001' where owner = 'del-a'$$,
  '23514', null, 'a deleted card can''t be worn again');
select throws_ok($$update chalito.avatar_creations set status = 'succeeded',
    manifest = '{"v": 1}' , deleted_at = null where creation_id = 'cr_del_a_free_0001'$$,
  '23514', null, 'a deleted creation never comes back');
select lives_ok($$update chalito.avatar_creations set files_deleted_at = now() where creation_id = 'cr_del_a_free_0001'$$,
  'the api records the drawings gone');
select lives_ok($$update chalito.avatar_creations set status = 'deleted' where creation_id = 'cr_del_a_free_0001'$$,
  'deleting again is harmless');

-- ================================================================ nothing given back
select is((select count(*)::int from chalito_private.avatar_free_markers
  where marker = md5('del-uid') || md5('del-uid2')), 1, 'the free-creation marker stays');
select throws_ok($$insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
    creation_id, owner, asset_id, free, content_type, upload_deadline)
  values (true, '18_plus', now(), 'cr_del_a_free_0002', 'del-a', 'dela000000000002', true, 'image/jpeg',
          now() + interval '30 minutes')$$,
  '23505', null, 'a deleted free creation still holds the free credit');

-- A card that isn't worn: deleting it leaves the companion alone.
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, reservation_id, content_type, upload_deadline)
values (true, '18_plus', now(), 'cr_del_b_paid_0001', 'del-b', 'delb000000000002', false, gen_random_uuid(), 'image/jpeg',
        now() + interval '30 minutes');
update chalito.avatar_creations set status = 'succeeded', manifest = '{"v": 1}' where creation_id = 'cr_del_b_paid_0001';
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, reservation_id, content_type, upload_deadline)
values (true, '18_plus', now(), 'cr_del_b_paid_0002', 'del-b', 'delb000000000003', false, gen_random_uuid(), 'image/jpeg',
        now() + interval '30 minutes');
update chalito.avatar_creations set status = 'succeeded', manifest = '{"v": 1}' where creation_id = 'cr_del_b_paid_0002';
update chalito.companions set asset_id = 'delb000000000003' where owner = 'del-b';
update chalito.avatar_creations set status = 'deleted' where creation_id = 'cr_del_b_paid_0001';
select is((select asset_id from chalito.companions where owner = 'del-b'), 'delb000000000003',
  'deleting a card that isn''t worn leaves the companion alone');
reset role;

select is(has_function_privilege('authenticated', 'chalito_private.avatar_creation_deleted()', 'execute'), false,
  'clients can''t call the trigger function');

select * from finish();
rollback;
