-- M11 rooms: every room rule, the realtime topic, TTL, promotion, rotation, dissolve.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

grant usage on schema extensions to chalito_server;

create function pg_temp.login(claims jsonb, topic text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  perform set_config('realtime.topic', coalesce(topic, ''), true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text, topic text default null)
returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role))), topic) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('realtime.topic', '', true);
end $$;
create function pg_temp.count(q text) returns integer language plpgsql as $$
declare n integer;
begin
  execute format('select count(*) from (%s) as q', q) into n;
  return n;
end $$;
-- A RoomSealed-shaped blob (content is opaque to the database).
create function pg_temp.ct(epoch int) returns jsonb language sql as $$
  select jsonb_build_object('alg', 'xchacha20poly1305', 'epoch', epoch, 'nonce', repeat('n', 32), 'ct', 'opaque') $$;
create function pg_temp.wrapped(devices text[]) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(d, repeat('k', 107)), '{}') from unnest(devices) d $$;

insert into chalito.tenants (id) values ('dad'), ('son'), ('stranger');
insert into chalito.users (id, tenant_id) values ('dad', 'dad'), ('son', 'son'), ('stranger', 'stranger');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
select o, d, r, case r when 'agent' then 'desktop' else 'phone' end, case r when 'agent' then 'linux' else 'ios' end, d,
  'p', 'p', 'f', case r when 'agent' then 'pairing' else 'first_client' end, md5(d)::uuid
from (values ('dad', 'dad_phone', 'client'), ('dad', 'dad_agent', 'agent'), ('son', 'son_phone', 'client'),
             ('stranger', 'str_phone', 'client')) v(o, d, r);
insert into chalito.companions (owner, companion_id, name) values
  ('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Papá'), ('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'Hijo'), ('stranger', 'chl_cccccccccccccccccccccccccc', 'Otro');
-- The companions trigger writes their directory rows (migration 20261004003040).

-- ================================================================ create / invite / join (as the api)
set local role chalito_server;
select lives_ok($$select chalito_private.room_create('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'family', 'Familia',
  pg_temp.wrapped(array['dad_phone']), 1)$$, 'create: the owner creates a room with epoch 1 keys');
select throws_ok($$select chalito_private.room_create('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r2', 'family', 'Otra', '{}', 1)$$, 'PT402', null,
  'create: the plan''s room limit applies');
select throws_ok($$select chalito_private.room_create('dad', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'r3', 'family', 'X', '{}', 5)$$, '42501', null,
  'create: only with your own companion');
select throws_ok($$select chalito_private.room_wrap_keys('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 1, pg_temp.wrapped(array['dad_agent']))$$,
  '22023', null, 'keys: only to the member''s client devices');
select lives_ok($$select chalito_private.room_invite('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'inv1', repeat('a', 64), repeat('b', 64), 1,
  now() + interval '7 days')$$, 'invite: a member invites (hashes only)');
select throws_ok($$select chalito_private.room_invite('stranger', 'chl_cccccccccccccccccccccccccc', 'r1', 'inv2', repeat('c', 64), repeat('d', 64), 1,
  now() + interval '7 days')$$, '42501', null, 'invite: a non-member can''t');
select throws_ok($$select chalito_private.room_join('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', repeat('b', 64), 1)$$, 'PT402', null,
  'join: the plan''s member limit applies');
select is(chalito_private.room_join('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', repeat('b', 64), 4), 'r1', 'join: the invitee joins with the short-code hash');
select throws_ok($$select chalito_private.room_join('stranger', 'chl_cccccccccccccccccccccccccc', repeat('b', 64), 4)$$, 'PT410', null,
  'join: a single-use invite works once');
select lives_ok($$select chalito_private.room_wrap_keys('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 1, pg_temp.wrapped(array['son_phone']))$$,
  'join: a member''s client wraps the key to the joiner''s devices');
reset role;

-- ================================================================ reads
select pg_temp.as_device('son', 'son_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.rooms where room_id = 'r1'$$), 1, 'read: members read the room');
select is(pg_temp.count($$select 1 from chalito.room_members where room_id = 'r1'$$), 2, 'read: and its members');
select is(pg_temp.count($$select 1 from chalito.room_member_keys$$), 1, 'keys: a device reads only its own wrapped keys');
select is(pg_temp.count($$select 1 from chalito.companion_directory where companion_id = 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa'$$), 1,
  'directory: co-members see each other');
select pg_temp.as_device('stranger', 'str_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.rooms$$) + pg_temp.count($$select 1 from chalito.room_members$$)
  + pg_temp.count($$select 1 from chalito.room_events$$), 0, 'read: non-members see nothing');
select is(pg_temp.count($$select 1 from chalito.companion_directory where companion_id <> 'chl_cccccccccccccccccccccccccc'$$), 0,
  'directory: companions aren''t searchable');
select throws_ok($$select * from chalito.room_invites$$, '42501', null, 'invites: server only');
select throws_ok($$insert into chalito.room_events (room_id, eid, from_companion_id, kind, ct, key_epoch)
  values ('r1', 'x', 'chl_cccccccccccccccccccccccccc', 'notice', '{"alg": "xchacha20poly1305"}', 1)$$, '42501', null, 'write: clients go through the api');
select pg_temp.logout();

-- ================================================================ posting
set local role chalito_server;
select lives_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e1', array['chl_bbbbbbbbbbbbbbbbbbbbbbbbbb'], 'event_proposal', 'normal',
  pg_temp.ct(1), 1)$$, 'post: a member posts as their own companion with the current epoch');
select ok((select t is not null and expires_at > now() + interval '23 hours' from chalito.room_events where eid = 'e1'),
  'post: the server stamps t and expires_at from retention (PT24H)');
select throws_ok($$select chalito_private.room_post('son', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e2', '{}', 'notice', 'low', pg_temp.ct(1), 1)$$,
  '42501', null, 'post: not as another member''s companion');
select throws_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e2', '{}', 'notice', 'low', pg_temp.ct(2), 2)$$,
  'PT409', null, 'post: only with the current key epoch');
select throws_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e2', '{}', 'notice', 'low', pg_temp.ct(2), 1)$$,
  'PT409', null, 'post: the sealed blob''s epoch must match too');
select throws_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e2', array['chl_cccccccccccccccccccccccccc'], 'notice', 'low', pg_temp.ct(1), 1)$$,
  '22023', null, 'post: only members can be addressed');
select throws_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e2', '{}', 'session.prompt', 'low', pg_temp.ct(1), 1)$$,
  '23514', null, 'post: no kind carries a command or prompt');
select throws_ok($$select chalito_private.room_post('stranger', 'chl_cccccccccccccccccccccccccc', 'r1', 'e2', '{}', 'notice', 'low', pg_temp.ct(1), 1)$$,
  '42501', null, 'post: non-members can''t');
reset role;
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:room:r1' and payload ->> 'table' = 'room_events'
  and inserted_at >= now()$$), 1, 'realtime: a pointer on chalito:room:<id>');
select is((select payload -> 'key' ->> 'eid' from realtime.messages where topic = 'chalito:room:r1'
  and payload ->> 'table' = 'room_events' and inserted_at >= now()), 'e1', 'realtime: carrying ids, not content');
select pg_temp.as_device('son', 'son_phone', 'client', 'chalito:room:r1');
select ok(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:room:r1'$$) > 0, 'realtime: members receive');
select is(pg_temp.count($$select 1 from chalito.room_events where room_id = 'r1'$$), 1, 'read: members read events');
select pg_temp.as_device('stranger', 'str_phone', 'client', 'chalito:room:r1');
select is(pg_temp.count($$select 1 from realtime.messages where topic = 'chalito:room:r1'$$), 0, 'realtime: non-members don''t');
select pg_temp.logout();
-- The injection fixture: content is sealed and inert; nothing becomes a command or a session prompt.
select is((select count(*)::int from chalito.commands) + (select count(*)::int from chalito.sessions), 0,
  'injection: a room event never produces a command or session row');

-- ================================================================ retention / promotion / TTL
set local role chalito_server;
select throws_ok($$select chalito_private.room_set_retention('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'r1', 'P7D', true)$$, '42501', null,
  'retention: only the owner changes it');
select is((chalito_private.room_set_retention('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'P7D', true)).ephemeral_ttl, 'P7D', 'retention: the owner does');
select is((chalito_private.room_promote('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'r1', 'e1', 'rec1', 'reminder',
  '{"alg": "xchacha20poly1305+sealedbox"}')).owner::text, 'son', 'promote: a durable record for the actor');
select ok((select promoted and expires_at is null and promoted_by = array['chl_bbbbbbbbbbbbbbbbbbbbbbbbbb'] from chalito.room_events where eid = 'e1'),
  'promote: the event is kept (keepPromoted clears its expiry)');
select lives_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e3', '{}', 'notice', 'low', pg_temp.ct(1), 1)$$,
  'ttl: another event');
reset role;
update chalito.room_events set expires_at = now() - interval '1 second' where eid = 'e3';
select pg_temp.as_device('son', 'son_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.room_events where eid = 'e3'$$), 0, 'ttl: expired events are hidden at once');
select is(pg_temp.count($$select 1 from chalito.records$$), 1, 'records: the actor reads their copy');
select pg_temp.as_device('dad', 'dad_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.records$$), 0, 'records: nobody else does');
select pg_temp.logout();
select chalito_private.purge_room_events();
select is((select count(*)::int from chalito.room_events where eid = 'e3'), 0, 'ttl: and purged');

-- ================================================================ leave / rotation
set local role chalito_server;
select throws_ok($$select chalito_private.room_leave('son', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1')$$, '42501', null,
  'leave: only your own membership');
select throws_ok($$select chalito_private.room_leave('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1')$$, 'PT409', null, 'leave: the owner dissolves instead');
select lives_ok($$select chalito_private.room_leave('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'r1')$$, 'leave: a member leaves');
select throws_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e4', '{}', 'notice', 'low', pg_temp.ct(1), 1)$$,
  'PT409', null, 'rotation: no posts until the key rotates');
select throws_ok($$select chalito_private.room_rotate('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 2,
  jsonb_build_object('chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.wrapped(array['dad_phone']), 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', pg_temp.wrapped(array['son_phone'])))$$,
  '22023', null, 'rotation: the new key goes only to remaining members');
select lives_ok($$select chalito_private.room_rotate('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 2,
  jsonb_build_object('chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.wrapped(array['dad_phone'])))$$, 'rotation: a remaining member installs epoch 2');
select lives_ok($$select chalito_private.room_post('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1', 'e4', '{}', 'notice', 'low', pg_temp.ct(2), 2)$$,
  'rotation: posting resumes on epoch 2');
reset role;
select pg_temp.as_device('son', 'son_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.room_events$$) + pg_temp.count($$select 1 from chalito.room_member_keys$$), 0,
  'leave: the removed member reads no events and holds no keys');

-- ================================================================ dissolve
select pg_temp.logout();
set local role chalito_server;
select throws_ok($$select chalito_private.room_dissolve('son', 'chl_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'r1')$$, '42501', null, 'dissolve: members can''t');
select lives_ok($$select chalito_private.room_dissolve('dad', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1')$$, 'dissolve: the owner can');
reset role;
select is((select count(*)::int from chalito.room_events where room_id = 'r1') + (select count(*)::int from chalito.room_members where room_id = 'r1')
  + (select count(*)::int from chalito.room_invites where room_id = 'r1'), 0, 'dissolve: events, members and invites are wiped');
select is((select count(*)::int from chalito.records where owner = 'son'), 1, 'dissolve: promoted records stay');

select * from finish();
rollback;
