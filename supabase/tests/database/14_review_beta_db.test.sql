-- Beta security review, database fixes (migration 20261004002500): R-H4, R-M7, R-L8.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
grant usage on schema extensions to chalito_server;

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into chalito.tenants (id) values ('rb-victim');
insert into chalito.users (id, tenant_id) values ('rb-victim', 'rb-victim');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('rb-victim', 'rb_phone', 'client', 'phone',   'ios',   'Phone', 'ps', 'pb', 'fp', 'first_client', md5('rb_phone')::uuid),
  ('rb-victim', 'rb_agent', 'agent',  'desktop', 'linux', 'Desk',  'ps', 'pb', 'fp', 'pairing',      md5('rb_agent')::uuid);
insert into chalito.sessions (owner, sid, device_id) values ('rb-victim', 'rb_s1', 'rb_agent');
insert into chalito.notifications (owner, nid, level, source, urgency, counts, deep_link, coalesce_key)
values ('rb-victim', 'rb_n1', 'L1', 'approval', 'normal', '{}', '/a/x', 'k1');

-- ================================================================ R-H4
select pg_temp.login(jsonb_build_object('sub', gen_random_uuid(), 'app_metadata',
  jsonb_build_object('chalito', jsonb_build_object('owner', 'rb-victim', 'role', 'user'))));
select is(chalito.jwt_role(), null, 'R-H4: app_metadata can''t claim the "user" role');
select is((select count(*)::int from chalito.devices), 0, 'R-H4: so a forged user claim sees none of the victim''s devices');
select throws_ok($$select chalito.get_my_settings()$$, '42501', null, 'R-H4: nor their settings');
select pg_temp.login(jsonb_build_object('sub', 'rb-victim', 'app_metadata', '{"provider": "email"}'::jsonb));
select is(chalito.jwt_role(), 'user', 'R-H4: the person''s own hub session is still a user');
select is((select count(*)::int from chalito.devices), 2, 'R-H4: and still sees their devices');
select pg_temp.as_device('rb-victim', 'rb_phone', 'client');
select is(chalito.jwt_role(), 'client', 'R-H4: device roles from app_metadata still work');
select pg_temp.logout();

-- ================================================================ R-M7
select ok(not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and 'anon' = any (roles) and coalesce(qual, '') || coalesce(with_check, '') like '%realtime_topic_ok%'),
  'R-M7: no realtime policy makes anon call the authenticated-only topic check');
select ok(exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and policyname = 'chalito_topics_guard_anon' and permissive = 'RESTRICTIVE'),
  'R-M7: anon still has a restrictive guard keeping it off chalito:* topics');

-- ================================================================ R-L8
select pg_temp.as_device('rb-victim', 'rb_agent', 'agent');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, expires_at, recommendations) values ('rb-victim', 'rb_a0', 'rb_agent', 'rb_s1', 'r0',
  'tool', 'LOW', 'local', false, '{}', now() + interval '5 minutes', '[{"by": "mcp:x", "allow": true}]')$$,
  '42501', null, 'R-L8: agents can''t seed recommendations');
select lives_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, expires_at) values ('rb-victim', 'rb_a1', 'rb_agent', 'rb_s1', 'r1',
  'tool', 'LOW', 'local', false, '{}', now() + interval '5 minutes')$$, 'R-L8: a plain approval is fine');
select lives_ok($$update chalito.approvals set status = 'denied', reason = 'expired', resolved_at = now() where aid = 'rb_a1'$$,
  'R-L8: the agent resolves its pending approval');
select throws_ok($$update chalito.approvals set status = 'pending', reason = null, resolved_at = null where aid = 'rb_a1'$$,
  '42501', null, 'R-L8: but can''t reopen it');

select pg_temp.as_device('rb-victim', 'rb_phone', 'client');
update chalito.notifications set state = 'acked', acked_at = '2020-01-01', acked_via = 'app' where nid = 'rb_n1';
select ok((select acked_at > now() - interval '1 minute' from chalito.notifications where nid = 'rb_n1'),
  'R-L8: an ack is stamped with server time, not the client''s');
select throws_ok($$update chalito.notifications set state = 'pending' where nid = 'rb_n1'$$, '42501', null,
  'R-L8: an acknowledged notification can''t be re-armed');
update chalito.notifications set state = 'acked', acked_at = now() + interval '1 day', acked_via = 'whatsapp' where nid = 'rb_n1';
select ok((select acked_at < now() + interval '1 minute' and acked_via = 'app' from chalito.notifications where nid = 'rb_n1'),
  'R-L8: a repeat ack is a no-op: the first ack''s time and channel stand');
select pg_temp.logout();

select throws_ok($$insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
  values ('rb-victim', 'orchestrator', 'client', 'web', 'web', 'X', 'ps', 'pb', 'fp', 'first_client')$$, '23514', null,
  'R-L8: no real device can take the orchestrator''s id');

select * from finish();
rollback;
