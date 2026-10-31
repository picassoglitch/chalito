-- Stuck/stall alerts and the app's calm actions (migration 20261025000100, from Alux by Omar).
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

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

insert into chalito.tenants (id) values ('ca-u');
insert into chalito.users (id, tenant_id) values ('ca-u', 'ca-u');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values ('ca-u', 'ca_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('ca_agent')::uuid),
       ('ca-u', 'ca_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('ca_phone')::uuid);
insert into chalito.sessions (owner, sid, device_id, doc) values ('ca-u', 's1', 'ca_agent', '{}');

-- ================================================================ agent.alert → agent_alert
select pg_temp.as_device('ca-u', 'ca_agent', 'agent');
select lives_ok($$insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc) values
  ('ca-u', 's1', 'e1', 'ca_agent', 1, now(), 'agent.alert', '{"kind":"stuck","turn":1761400000000,"count":5}'),
  ('ca-u', 's1', 'e2', 'ca_agent', 2, now(), 'agent.alert', '{"kind":"bogus","turn":1761400000000}'),
  ('ca-u', 's1', 'e3', 'ca_agent', 3, now(), 'agent.alert', '{"kind":"stalled","turn":"x; drop"}')$$,
  'an agent writes its alert events (malformed ones too: they must not fail the batch)');
select pg_temp.logout();
select results_eq(
  $$select message -> 'item' ->> 'source', message -> 'item' ->> 'level', message -> 'item' ->> 'coalesceKey',
           message -> 'item' ->> 'nid', message -> 'item' ->> 'sid', message -> 'item' ->> 'deepLink'
      from chalito_private.notify_outbox where owner = 'ca-u' and starts_with(source_key, 'alert:')$$,
  $$values ('agent_alert'::text, 'L2'::text, 'alert:s1:1761400000000'::text, 'al_s1_1761400000000'::text, 's1'::text, '/s/s1'::text)$$,
  'a stuck alert queues one L2 agent_alert per turn; malformed ones queue nothing');

-- ================================================================ the next prompt acks the session's alerts
select pg_temp.as_device('ca-u', 'ca_agent', 'agent');
insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
  values ('ca-u', 's1', 'e4', 'ca_agent', 4, now(), 'message.user', '{"origin":"client:ca_phone"}'),
         ('ca-u', 's1', 'e5', 'ca_agent', 5, now(), 'message.user', '{"origin":"agent:coord"}');
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  values ('ca-u', 'apr_ca', 'ca_agent', 's1', 'rq1', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes');
select pg_temp.logout();
select is((select message from chalito_private.notify_outbox where source_key = 'session_ack:ca-u:s1:e4'),
  '{"v": 1, "uid": "ca-u", "sid": "s1", "via": "app", "type": "ack", "sources": ["agent_alert", "session_question"]}'::jsonb,
  'a new prompt acks that session''s alerts and open question');
select ok(exists (select 1 from chalito_private.notify_outbox where source_key = 'turn_ack:ca-u:s1:e4'),
  'and still the "finished" push');
select ok(not exists (select 1 from chalito_private.notify_outbox where source_key = 'session_ack:ca-u:s1:e5'),
  'a coordinator''s prompt acks none of the person''s alerts');
select is((select message -> 'item' ->> 'sid' from chalito_private.notify_outbox where source_key = 'approval:ca-u:apr_ca'),
  's1', 'approval items name their session');

-- ================================================================ chalito.notification_action
select pg_temp.as_device('ca-u', 'ca_phone', 'client');
select lives_ok($$select chalito.notification_action('seen', 's1')$$, 'a client reports a session it opened');
select lives_ok($$select chalito.notification_action('seen', 's1')$$, 'twice');
select lives_ok($$select chalito.notification_action('snooze', null, 'al_s1_1761400000000')$$, 'and postpones one alert');
select lives_ok($$select chalito.notification_action('waiting', 's1')$$, 'parks a session');
select lives_ok($$select chalito.notification_action('not_waiting', 's1')$$, 'and undoes it at once');
select throws_ok($$select chalito.notification_action('delete', 's1')$$, '22023', null, 'only the four actions');
select throws_ok($$select chalito.notification_action('snooze', 's1')$$, '22023', null, 'snooze names a notification');
select throws_ok($$select chalito.notification_action('seen', 's1/../x')$$, '22023', null, 'ids are plain ids');
select pg_temp.as_device('ca-u', 'ca_agent', 'agent');
select throws_ok($$select chalito.notification_action('seen', 's1')$$, '42501', null, 'an agent can''t');
select pg_temp.logout();
select results_eq(
  $$select message ->> 'type', coalesce(message ->> 'sid', message ->> 'nid') from chalito_private.notify_outbox
     where owner = 'ca-u' and (starts_with(source_key, 'seen:') or starts_with(source_key, 'snooze:')) order by id$$,
  $$values ('seen'::text, 's1'::text), ('snooze_alert'::text, 'al_s1_1761400000000'::text)$$,
  'a repeated seen within the second is deduped; the snooze reaches the outbox');
-- Park and undo can't share a dedupe key, or the undo would be dropped.
select results_eq(
  $$select message ->> 'on' from chalito_private.notify_outbox
     where owner = 'ca-u' and message ->> 'type' = 'waiting' order by id$$,
  $$values ('true'::text), ('false'::text)$$,
  'the park and its undo both reach the outbox, in order');

select * from finish();
rollback;
