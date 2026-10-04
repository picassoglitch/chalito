-- ADR 0018: an endorsement insert points the account's agents (only) at it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

create function pg_temp.sent(p_topic text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'table' = 'endorsements' and inserted_at >= now() $$;

insert into chalito.tenants (id) values ('eb-user'), ('eb-other');
insert into chalito.users (id, tenant_id) values ('eb-user', 'eb-user'), ('eb-other', 'eb-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('eb-user',  'eb_agent',   'agent',  'desktop', 'linux', 'Desk',  'ps', 'pb', 'fp', 'pairing',      false),
  ('eb-user',  'eb_oldagt',  'agent',  'laptop',  'linux', 'Old',   'ps', 'pb', 'fp', 'pairing',      true),
  ('eb-user',  'eb_phone',   'client', 'phone',   'ios',   'Phone', 'ps', 'pb', 'fp', 'first_client', false),
  ('eb-other', 'eb_stranger','agent',  'desktop', 'linux', 'Other', 'ps', 'pb', 'fp', 'pairing',      false);

insert into chalito.endorsements (owner, device_id, endorsement) values ('eb-user', 'eb_new', '{"ctx": "chalito.endorsement.v1"}');

select is(pg_temp.sent('chalito:device:eb_agent'), 1, 'broadcast: the account''s agent is told');
select is(pg_temp.sent('chalito:device:eb_phone'), 0, 'broadcast: not the clients');
select is(pg_temp.sent('chalito:device:eb_oldagt'), 0, 'broadcast: never a revoked agent');
select is(pg_temp.sent('chalito:device:eb_stranger'), 0, 'broadcast: never another account');
select is((select payload -> 'key' from realtime.messages where topic = 'chalito:device:eb_agent'
  and payload ->> 'table' = 'endorsements'), '{"device_id": "eb_new"}'::jsonb, 'broadcast: a pointer, not the endorsement');

select * from finish();
rollback;
