-- Migration 003520: a device's push subscriptions and call lines go when it's revoked (any revoke
-- path), and with the account; other devices' stay.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

grant usage on schema extensions to chalito_server;

insert into chalito.tenants (id) values ('ps-user');
insert into chalito.users (id, tenant_id) values ('ps-user', 'ps-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values
  ('ps-user', 'ps_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client'),
  ('ps-user', 'ps_web', 'client', 'web', 'web', 'Web', 'p', 'p', 'f', 'endorsement'),
  ('ps-user', 'ps_tablet', 'client', 'phone', 'ios', 'Tablet', 'p', 'p', 'f', 'endorsement'),
  ('ps-user', 'ps_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing'),
  ('ps-user', 'ps_agent2', 'agent', 'laptop', 'linux', 'Laptop 2', 'p', 'p', 'f', 'pairing');
insert into chalito.call_lines (owner, lid, notification_id, device_id, sid, line, expires_at)
values
  ('ps-user', 'l_1', 'n_1', 'ps_agent', 's_1', 'Pregunta sobre el despliegue', now() + interval '10 minutes'),
  ('ps-user', 'l_2', 'n_1', 'ps_agent2', 's_2', 'Otra pregunta', now() + interval '10 minutes');
insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
values
  ('ps-user', 'ps_phone', 'https://push.example.test/phone', 'k', 'a'),
  ('ps-user', 'ps_web', 'https://push.example.test/web', 'k', 'a'),
  ('ps-user', 'ps_tablet', 'https://push.example.test/tablet', 'k', 'a');

-- As the api revokes one device (repo.revokeDevice runs as chalito_server).
set local role chalito_server;
update chalito.devices set revoked = true, revoked_at = now(), revoked_by = 'ps_web'
  where owner = 'ps-user' and device_id = 'ps_phone';
reset role;
select is((select count(*)::int from chalito.push_subscriptions where device_id = 'ps_phone'), 0,
  'revoking a device drops its push subscriptions');
select is((select count(*)::int from chalito.push_subscriptions where owner = 'ps-user'), 2,
  'the other devices keep theirs');

-- Revoke-all (repo.revokeOtherClients): every other client at once.
set local role chalito_server;
update chalito.devices set revoked = true, revoked_at = now(), revoked_by = 'ps_web'
  where owner = 'ps-user' and role = 'client' and revoked = false and device_id <> 'ps_web';
reset role;
select is((select array_agg(device_id::text order by device_id) from chalito.push_subscriptions where owner = 'ps-user'),
  array['ps_web']::text[], 'revoke-all leaves only the caller''s subscription');

-- An update that doesn't revoke leaves subscriptions alone.
update chalito.devices set last_seen_at = now() where device_id = 'ps_web';
select is((select count(*)::int from chalito.push_subscriptions where device_id = 'ps_web'), 1,
  'other device updates don''t touch subscriptions');

select has_trigger('chalito', 'devices', 'devices_revoked_drop_push', 'the revoke trigger exists');

-- A revoked agent's call lines go (a call must not read them out); the other agent's stay.
set local role chalito_server;
update chalito.devices set revoked = true where owner = 'ps-user' and device_id = 'ps_agent';
reset role;
select is((select count(*)::int from chalito.call_lines where device_id = 'ps_agent'), 0,
  'revoking an agent drops its call lines');
select is((select count(*)::int from chalito.call_lines where device_id = 'ps_agent2'), 1,
  'another agent''s call lines stay');

-- Account deletion: users → devices → push_subscriptions.
select chalito_private.delete_account('ps-user');
select is((select count(*)::int from chalito.push_subscriptions where owner = 'ps-user'), 0,
  'deleting the account drops every subscription');

select * from finish();
rollback;
