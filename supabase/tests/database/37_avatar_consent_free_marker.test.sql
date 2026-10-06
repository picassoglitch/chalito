-- Custom companions, migration 20261005000200: every new creation carries a valid self-attestation
-- (own photo; 18+, or 13–17 with a guardian's permission; no under-13 band); a free success leaves
-- its markers in chalito_private.avatar_free_markers, which account deletion keeps and clients can't
-- read; use_when_ready puts the card on the companion in the same transaction as the success.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
grant usage on schema extensions to chalito_server;

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;

insert into chalito.tenants (id) values ('fm-a'), ('fm-b');
insert into chalito.users (id, tenant_id) values ('fm-a', 'fm-a'), ('fm-b', 'fm-b');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values ('fm-b', 'fm_b_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('fm_b_phone')::uuid, false);
insert into chalito.companions (owner, companion_id, name, avatar) values
  ('fm-a', 'chl_fmaaaaaaaaaaaaaaaaaaaaaaaa', 'A', 'luna'),
  ('fm-b', 'chl_fmbbbbbbbbbbbbbbbbbbbbbbbb', 'B', 'tito');

set local role chalito_server;
-- ================================================================ attestation
select throws_ok($$insert into chalito.avatar_creations (creation_id, owner, asset_id, free, content_type, upload_deadline)
  values ('cr_fm_no_attest_001', 'fm-a', 'fmaa000000000001', true, 'image/jpeg', now() + interval '30 minutes')$$,
  '23514', null, 'a new creation needs the attestation');
select throws_ok($$insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attest_guardian, attested_at,
    creation_id, owner, asset_id, free, content_type, upload_deadline)
  values (true, '13_17', false, now(), 'cr_fm_teen_no_ok_01', 'fm-a', 'fmaa000000000002', true, 'image/jpeg', now() + interval '30 minutes')$$,
  '23514', null, '13–17 needs a guardian''s permission');
select throws_ok($$insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attest_guardian, attested_at,
    creation_id, owner, asset_id, free, content_type, upload_deadline)
  values (true, 'under_13', true, now(), 'cr_fm_child_000001', 'fm-a', 'fmaa000000000003', true, 'image/jpeg', now() + interval '30 minutes')$$,
  '23514', null, 'there is no under-13 band');
select throws_ok($$insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attest_guardian, attested_at,
    creation_id, owner, asset_id, free, content_type, upload_deadline)
  values (false, '18_plus', false, now(), 'cr_fm_not_mine_001', 'fm-a', 'fmaa000000000004', true, 'image/jpeg', now() + interval '30 minutes')$$,
  '23514', null, 'the photo must be confirmed as the person''s own');
select throws_ok($$insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
    creation_id, owner, asset_id, free, reservation_id, content_type, upload_deadline, free_markers)
  values (true, '18_plus', now(), 'cr_fm_paid_marks01', 'fm-a', 'fmaa000000000005', false, gen_random_uuid(), 'image/jpeg',
          now() + interval '30 minutes', array[md5('x') || md5('y')])$$,
  '23514', null, 'only a free creation carries markers');

-- ================================================================ markers
-- A failed free attempt leaves none.
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attest_guardian, attested_at,
  creation_id, owner, asset_id, free, content_type, upload_deadline, free_markers)
values (true, '13_17', true, now(), 'cr_fm_a_free_fail1', 'fm-a', 'fmaa000000000006', true, 'image/jpeg',
        now() + interval '30 minutes', array[md5('uid-a') || md5('uid-a2'), md5('em-a') || md5('em-a2')]);
update chalito.avatar_creations set status = 'failed', failure = 'refused' where creation_id = 'cr_fm_a_free_fail1';
select is((select count(*)::int from chalito_private.avatar_free_markers
  where marker in (md5('uid-a') || md5('uid-a2'), md5('em-a') || md5('em-a2'))), 0, 'a failed free attempt leaves no marker');

-- A free success leaves both (hub id and email), and use_when_ready puts the card on.
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, content_type, upload_deadline, free_markers, use_when_ready)
values (true, '18_plus', now(), 'cr_fm_a_free_ok01', 'fm-a', 'fmaa000000000007', true, 'image/jpeg',
        now() + interval '30 minutes', array[md5('uid-a') || md5('uid-a2'), md5('em-a') || md5('em-a2')], true);
update chalito.avatar_creations set status = 'generating' where creation_id = 'cr_fm_a_free_ok01';
update chalito.avatar_creations
  set status = 'succeeded', manifest = '{"v": 1, "emotions": {"mode": "swap", "src": {"neutral": "layer-neutral.webp"}}}'
  where creation_id = 'cr_fm_a_free_ok01';
select is((select count(*)::int from chalito_private.avatar_free_markers
  where marker in (md5('uid-a') || md5('uid-a2'), md5('em-a') || md5('em-a2'))), 2, 'a free success leaves its markers');
select results_eq($$select asset_id, expression_map from chalito.companions where owner = 'fm-a'$$,
  $$values ('fmaa000000000007'::text, '{"mode": "swap", "src": {"neutral": "layer-neutral.webp"}}'::jsonb)$$,
  'use_when_ready: the companion wears the card as soon as it succeeds');

-- Without use_when_ready the companion is left alone.
insert into chalito.avatar_creations (attest_own_photo, attest_age_band, attested_at,
  creation_id, owner, asset_id, free, content_type, upload_deadline)
values (true, '18_plus', now(), 'cr_fm_b_free_ok01', 'fm-b', 'fmbb000000000001', true, 'image/jpeg', now() + interval '30 minutes');
update chalito.avatar_creations set status = 'succeeded', manifest = '{"v": 1, "emotions": {"mode": "swap", "src": {}}}'
  where creation_id = 'cr_fm_b_free_ok01';
select results_eq($$select asset_id from chalito.companions where owner = 'fm-b'$$,
  $$values (null::text)$$, 'no use_when_ready: the companion keeps its roster avatar');

-- ================================================================ account deletion keeps them
select lives_ok($$select chalito_private.delete_account('fm-a')$$, 'the owner''s account is deleted');
select is((select count(*)::int from chalito.avatar_creations where owner = 'fm-a'), 0, '…its creations are gone');
select is((select count(*)::int from chalito_private.avatar_free_markers
  where marker in (md5('uid-a') || md5('uid-a2'), md5('em-a') || md5('em-a2'))), 2,
  '…but the free-creation markers stay (no second free creation after re-signup)');
reset role;

-- ================================================================ never readable by clients
select pg_temp.as_device('fm-b', 'fm_b_phone', 'client');
select throws_ok($$select * from chalito_private.avatar_free_markers$$, '42501', null, 'clients can''t read the markers');
reset role;

select * from finish();
rollback;
