-- Migration 003520: a device's push subscriptions go when it's revoked (any revoke path), and with
-- the account; other devices' subscriptions stay.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

grant usage on schema extensions to chalito_server;

insert into chalito.tenants (id) values ('ps-user');
insert into chalito.users (id, tenant_id) values ('ps-user', 'ps-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values
  ('ps-user', 'ps_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client'),
  ('ps-user', 'ps_web', 'client', 'web', 'web', 'Web', 'p', 'p', 'f', 'endorsement'),
  ('ps-user', 'ps_tablet', 'client', 'phone', 'ios', 'Tablet', 'p', 'p', 'f', 'endorsement');
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
select is((select array_agg(device_id order by device_id) from chalito.push_subscriptions where owner = 'ps-user'),
  array['ps_web']::text[], 'revoke-all leaves only the caller''s subscription');

-- An update that doesn't revoke leaves subscriptions alone.
update chalito.devices set last_seen_at = now() where device_id = 'ps_web';
select is((select count(*)::int from chalito.push_subscriptions where device_id = 'ps_web'), 1,
  'other device updates don''t touch subscriptions');

select has_trigger('chalito', 'devices', 'devices_revoked_drop_push', 'the revoke trigger exists');

-- Account deletion: users → devices → push_subscriptions.
select chalito_private.delete_account('ps-user');
select is((select count(*)::int from chalito.push_subscriptions where owner = 'ps-user'), 0,
  'deleting the account drops every subscription');

select * from finish();
rollback;
