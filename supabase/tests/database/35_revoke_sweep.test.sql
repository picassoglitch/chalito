-- Migration 003530: what a revoke also ends. An agent: its pending approvals are denied
-- (agent_revoked) and the ack is queued for the escalation engine; its plaintext session cards go.
-- A client holding room keys: those rooms need a rotation and its key rows go. Others untouched.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

grant usage on schema extensions to chalito_server;

insert into chalito.tenants (id) values ('rv-user'), ('rv-other');
insert into chalito.users (id, tenant_id) values ('rv-user', 'rv-user'), ('rv-other', 'rv-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values
  ('rv-user', 'rv_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client'),
  ('rv-user', 'rv_web', 'client', 'web', 'web', 'Web', 'p', 'p', 'f', 'endorsement'),
  ('rv-user', 'rv_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing'),
  ('rv-user', 'rv_agent2', 'agent', 'laptop', 'linux', 'Laptop 2', 'p', 'p', 'f', 'pairing'),
  ('rv-other', 'rv_other_phone', 'client', 'phone', 'ios', 'Other', 'p', 'p', 'f', 'first_client');
insert into chalito.sessions (owner, sid, device_id) values ('rv-user', 'rv_s1', 'rv_agent'), ('rv-user', 'rv_s2', 'rv_agent2');
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values
  ('rv-user', 'rv_a1', 'rv_agent', 'rv_s1', 'r1', 'tool', 'HIGH', 'local', true, '{}', now() + interval '10 minutes'),
  ('rv-user', 'rv_a2', 'rv_agent2', 'rv_s2', 'r2', 'tool', 'HIGH', 'local', true, '{}', now() + interval '10 minutes');
insert into chalito.session_card_plain (owner, sid, device_id, card)
values ('rv-user', 'rv_s1', 'rv_agent', '{"goal": "g"}'), ('rv-user', 'rv_s2', 'rv_agent2', '{"goal": "h"}');

insert into chalito.companions (owner, companion_id, name) values
  ('rv-user', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'Uno'), ('rv-other', 'chl_rvbbbbbbbbbbbbbbbbbbbbbbbb', 'Dos');
insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id)
values ('rv_room1', 'family', 'Casa', 'rv-other', 'chl_rvbbbbbbbbbbbbbbbbbbbbbbbb'),
       ('rv_room2', 'family', 'Otra', 'rv-other', 'chl_rvbbbbbbbbbbbbbbbbbbbbbbbb');
insert into chalito.room_members (room_id, companion_id, uid, role)
values ('rv_room1', 'chl_rvbbbbbbbbbbbbbbbbbbbbbbbb', 'rv-other', 'owner'),
       ('rv_room1', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'rv-user', 'member'),
       ('rv_room2', 'chl_rvbbbbbbbbbbbbbbbbbbbbbbbb', 'rv-other', 'owner'),
       ('rv_room2', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'rv-user', 'member');
-- The phone holds rv_room1's key; only the web holds rv_room2's.
insert into chalito.room_member_keys (room_id, companion_id, uid, device_id, epoch, ct)
values ('rv_room1', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'rv-user', 'rv_phone', 1, repeat('A', 107)),
       ('rv_room1', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'rv-user', 'rv_web', 1, repeat('B', 107)),
       ('rv_room2', 'chl_rvaaaaaaaaaaaaaaaaaaaaaaaa', 'rv-user', 'rv_web', 1, repeat('C', 107));

-- ---------------------------------------------------------------- an agent is revoked
set local role chalito_server;
update chalito.devices set revoked = true, revoked_at = now() where owner = 'rv-user' and device_id = 'rv_agent';
reset role;
select is((select status || '/' || reason from chalito.approvals where aid = 'rv_a1'), 'denied/agent_revoked',
  'a revoked agent''s pending approval is denied (agent_revoked)');
select ok(exists (select 1 from chalito_private.notify_outbox
                  where owner = 'rv-user' and message ->> 'type' = 'ack' and message ->> 'nid' = 'rv_a1'),
  'and its ack is queued: the escalation ladder stops');
select is((select status from chalito.approvals where aid = 'rv_a2'), 'pending', 'another agent''s approval stays');
select is((select count(*)::int from chalito.session_card_plain where device_id = 'rv_agent'), 0,
  'its shared plaintext cards go');
select is((select count(*)::int from chalito.session_card_plain where device_id = 'rv_agent2'), 1,
  'another agent''s card stays');
select is((select count(*)::int from chalito.rooms where needs_rotation), 0, 'an agent never touches rooms');

-- ---------------------------------------------------------------- a client holding room keys is revoked
set local role chalito_server;
update chalito.devices set revoked = true, revoked_at = now() where owner = 'rv-user' and device_id = 'rv_phone';
reset role;
select is((select needs_rotation from chalito.rooms where room_id = 'rv_room1'), true,
  'a room whose key the revoked phone held needs a rotation');
select is((select needs_rotation from chalito.rooms where room_id = 'rv_room2'), false,
  'a room it held no key for doesn''t');
select is((select count(*)::int from chalito.room_member_keys where device_id = 'rv_phone'), 0,
  'its sealed key rows go');
select is((select count(*)::int from chalito.room_member_keys where device_id = 'rv_web'), 2,
  'the member''s other device keeps its keys');
select has_function('chalito_private', 'drop_revoked_device_reach', 'the revoke trigger function exists');

select * from finish();
rollback;
