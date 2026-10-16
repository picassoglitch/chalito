-- Migration 20261015000200 (ADR 0022 §3): an active agent relays signed agent-link envelopes to
-- another active agent of the same owner, and nothing else; clients still can't relay; the
-- link_handoff approval kind (MED, one tap); link.* in its own audit category.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object('provider', 'chalito',
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- An agent-link envelope from `signer` to `target` (shape of RelayedCommand, agent-link).
create function pg_temp.relay(signer text, target text, origin text, ptype text) returns jsonb language sql as $$
  select jsonb_build_object('relayedBy', 'agent-link', 'signerDeviceId', signer, 'sig', 'x',
    'body', jsonb_build_object('v', 1, 'cid', 'c1', 'uid', 'al-user', 'targetDeviceId', target, 'origin', origin,
      'payload', jsonb_build_object('type', ptype, 'linkId', 'lnk_abcdefgh'))) $$;

insert into chalito.tenants (id) values ('al-user'), ('al-other');
insert into chalito.users (id, tenant_id) values ('al-user', 'al-user'), ('al-other', 'al-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('al-user', 'al_a', 'agent', 'desktop', 'linux', 'A', 'p', 'p', 'f', 'pairing', false),
  ('al-user', 'al_b', 'agent', 'laptop', 'macos', 'B', 'p', 'p', 'f', 'pairing', false),
  ('al-user', 'al_old', 'agent', 'laptop', 'linux', 'Old', 'p', 'p', 'f', 'pairing', true),
  ('al-user', 'al_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', false),
  ('al-other', 'al_x', 'agent', 'desktop', 'linux', 'X', 'p', 'p', 'f', 'pairing', false);
update chalito.devices set auth_user_id = md5(device_id)::uuid;

select pg_temp.as_device('al-user', 'al_a', 'agent');
select lives_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r1', pg_temp.relay('al_a', 'al_b', 'agent:s1', 'link.handoff'), 'al_a')$$,
  'an agent relays a hand-off to another agent of the owner');
select lives_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r2', pg_temp.relay('al_a', 'al_b', 'agent:s1', 'link.result'), 'al_a')$$,
  'and a result');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r3', pg_temp.relay('al_a', 'al_b', 'agent:s1', 'session.prompt'), 'al_a')$$,
  '42501', null, 'only the link payloads');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r4', pg_temp.relay('al_a', 'al_b', 'client:al_phone', 'link.handoff'), 'al_a')$$,
  '42501', null, 'only from an agent: origin');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r5', pg_temp.relay('al_b', 'al_b', 'agent:s1', 'link.handoff'), 'al_a')$$,
  '42501', null, 'never signed in another device''s name');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_old', 'r6', pg_temp.relay('al_a', 'al_old', 'agent:s1', 'link.handoff'), 'al_a')$$,
  '42501', null, 'never to a revoked agent');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_phone', 'r7', pg_temp.relay('al_a', 'al_phone', 'agent:s1', 'link.handoff'), 'al_a')$$,
  '42501', null, 'never to a client');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r8', pg_temp.relay('al_a', 'al_x', 'agent:s1', 'link.handoff'), 'al_a')$$,
  '42501', null, 'the envelope names the row''s target');
select pg_temp.logout();

select pg_temp.as_device('al-user', 'al_phone', 'client');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r9', pg_temp.relay('al_phone', 'al_b', 'agent:s1', 'link.handoff'), 'al_phone')$$,
  '42501', null, 'a client can''t relay a hand-off');
select pg_temp.logout();

select pg_temp.as_device('al-user', 'al_old', 'agent');
select throws_ok(
  $$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
    values ('al-user', 'al_b', 'r10', pg_temp.relay('al_old', 'al_b', 'agent:s1', 'link.handoff'), 'al_old')$$,
  '42501', null, 'a revoked agent can''t relay');
select pg_temp.logout();

insert into chalito.sessions (owner, sid, device_id) values ('al-user', 'al_s1', 'al_b');
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('al-user', 'al_ap1', 'al_b', 'al_s1', 'r1', 'link_handoff', 'MED', 'agent:s1', false, '{}', now() + interval '10 minutes')$$,
  'a link_handoff approval (one tap) is accepted');
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('al-user', 'al_ap2', 'al_b', 'al_s1', 'r2', 'remote_view', 'HIGH', 'client:p', true, '{}', now() + interval '10 minutes')$$,
  'earlier kinds are kept');
select is(chalito.audit_category('link.handoff.delivered'), 'links', 'link.* has its own category');
select is(chalito.audit_category('lan.link_up'), 'lan', 'lan.* has its own category');
select has_view('chalito', 'audit_lan', 'and its own view');
select is(chalito.audit_category('screen.ended'), 'screen', 'screen.* unchanged');

select * from finish();
rollback;
