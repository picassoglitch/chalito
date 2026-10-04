-- The notify outbox (migration 20261004003050): the sources queue messages in the same transaction,
-- including an agent's own approval insert under RLS, and no client can read or write the outbox.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
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

insert into chalito.tenants (id) values ('no-u');
insert into chalito.users (id, tenant_id) values ('no-u', 'no-u');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values ('no-u', 'no_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('no_agent')::uuid),
       ('no-u', 'no_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('no_phone')::uuid);
insert into chalito.sessions (owner, sid, device_id, doc) values ('no-u', 's1', 'no_agent', '{}');

-- The agent inserts its own pending approval (RLS: active agent, about itself).
select pg_temp.as_device('no-u', 'no_agent', 'agent');
select lives_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  values ('no-u', 'apr_pg', 'no_agent', 's1', 'rq1', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes')$$,
  'an agent inserts its pending approval');
select pg_temp.logout();
select results_eq(
  $$select source_key, message ->> 'type', message -> 'item' ->> 'level', status from chalito_private.notify_outbox where owner = 'no-u'$$,
  $$values ('approval:no-u:apr_pg'::text, 'notify'::text, 'L2'::text, 'pending'::text)$$,
  'it queued a notify (MED → L2) in the same transaction');

update chalito.approvals set status = 'denied', resolved_at = now() where owner = 'no-u' and aid = 'apr_pg';
select is((select message ->> 'type' from chalito_private.notify_outbox where source_key = 'approval_end:no-u:apr_pg'),
  'ack', 'resolving it queues an ack');
select is((select count(*)::int from chalito_private.notify_outbox where owner = 'no-u'), 2, 'one row per source key');

-- ================================================================ clients never touch the outbox
select pg_temp.as_device('no-u', 'no_phone', 'client');
select throws_ok($$select count(*) from chalito_private.notify_outbox$$, '42501', null, 'a client can''t read the outbox');
select throws_ok($$update chalito_private.notify_outbox set status = 'sent'$$, '42501', null, 'a client can''t write it');
select throws_ok($$select chalito_private.notify_enqueue('no-u', 'x', '{}')$$, '42501', null, 'a client can''t queue');
select throws_ok($$select chalito_private.notify_poke(1)$$, '42501', null, 'a client can''t poke');
select pg_temp.logout();

select * from finish();
rollback;
