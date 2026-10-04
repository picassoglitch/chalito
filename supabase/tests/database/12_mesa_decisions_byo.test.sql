-- Migration 002300: the orchestrator can only CREATE pending Mesa decisions and can never resolve
-- one; the person's signed decision resolves it. BYO brain keys: sealed copy readable by the
-- person's clients, KMS-wrapped copy server-only, and gone when cloud turns are turned off.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

grant usage on schema extensions to chalito_server, chalito_gateway;

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
create function pg_temp.decision(aid text, signer text, allow boolean, target text default 'orchestrator') returns jsonb
language sql as $$
  select jsonb_build_object('ctx', 'chalito.decision.v1', 'signerDeviceId', signer, 'sig', 'x',
    'body', jsonb_build_object('v', 1, 'aid', aid, 'targetDeviceId', target, 'allow', allow, 'choice', 1)) $$;

insert into chalito.tenants (id) values ('dc-user');
insert into chalito.users (id, tenant_id) values ('dc-user', 'dc-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('dc-user', 'dc_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('dc_phone')::uuid),
  ('dc-user', 'dc_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('dc_agent')::uuid);
insert into chalito.sessions (owner, sid, device_id) values ('dc-user', 's_1', 'dc_agent');
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values ('dc-user', 'apr_agent', 'dc_agent', 's_1', 'r', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes');

-- ---------------------------------------------------------------- the orchestrator creates, only that
set local role chalito_server;
select lives_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  values ('dc-user', 'apr_m1', 'orchestrator', 'm_1', 't_1', 'decision', 'MED', 'client:dc_phone', false, '{"ct": "x"}', now() + interval '10 minutes')$$,
  'orchestrator: creates a pending Mesa decision');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  values ('dc-user', 'apr_t', 'orchestrator', 'm_1', 't_2', 'tool', 'MED', 'local', false, '{}', now() + interval '5 minutes')$$,
  '42501', null, 'orchestrator: no tool approvals');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at, status)
  values ('dc-user', 'apr_s', 'orchestrator', 'm_1', 't_3', 'decision', 'MED', 'local', false, '{}', now() + interval '5 minutes', 'approved')$$,
  '42501', null, 'orchestrator: can''t create one already approved');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  values ('dc-user', 'apr_d', 'dc_agent', 'm_1', 't_4', 'decision', 'MED', 'local', false, '{}', now() + interval '5 minutes')$$,
  '42501', null, 'orchestrator: can''t create one for an agent device');
select throws_ok($$update chalito.approvals set status = 'approved' where aid = 'apr_m1'$$, '42501', null,
  'orchestrator: can never resolve a decision');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('dc-user', 'apr_m1', 'dc_phone', '{}')$$, '42501', null, 'orchestrator: nor sign one');
reset role;

-- ---------------------------------------------------------------- the person decides
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('dc-user', 'apr_m1', 'dc_phone', pg_temp.decision('apr_m1', 'dc_phone', false))$$,
  'client: signs the Mesa decision as usual');
select pg_temp.logout();
select is((select status || '/' || reason from chalito.approvals where aid = 'apr_m1'), 'denied/signed:dc_phone:choice=1',
  'the person''s signed decision resolves it');

-- An agent's approval is never resolved this way (its agent verifies and resolves it).
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
values ('dc-user', 'apr_agent', 'dc_phone', pg_temp.decision('apr_agent', 'dc_phone', true, 'dc_agent'));
select pg_temp.logout();
select is((select status from chalito.approvals where aid = 'apr_agent'), 'pending', 'agent approvals: untouched by the trigger');

-- A decision whose body names another approval doesn't resolve this one.
set local role chalito_server;
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values ('dc-user', 'apr_m2', 'orchestrator', 'm_1', 't_5', 'decision', 'MED', 'client:dc_phone', false, '{}', now() + interval '10 minutes');
reset role;
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
values ('dc-user', 'apr_m2', 'dc_phone', pg_temp.decision('apr_m1', 'dc_phone', true));
select pg_temp.logout();
select is((select status from chalito.approvals where aid = 'apr_m2'), 'pending', 'a decision for another aid doesn''t resolve it');

-- ---------------------------------------------------------------- BYO brain keys
set local role chalito_server;
insert into chalito.brain_keys (owner, provider, sealed_ct, hint, cloud) values ('dc-user', 'openai', '{"ct": "s"}', '1234', true);
insert into chalito_private.brain_key_wrapped (owner, provider, wrapped) values ('dc-user', 'openai', 'kms-wrapped');
select throws_ok($$insert into chalito.brain_keys (owner, provider, sealed_ct, hint) values ('dc-user', 'mistral', '{}', 'x')$$,
  '23514', null, 'only known providers');
reset role;

select pg_temp.as_device('dc-user', 'dc_phone', 'client');
select is((select hint from chalito.brain_keys where provider = 'openai'), '1234', 'client: reads its sealed key row');
select throws_ok($$select * from chalito_private.brain_key_wrapped$$, '42501', null, 'client: never the wrapped copy');
select throws_ok($$update chalito.brain_keys set cloud = true$$, '42501', null, 'client: writes only through the orchestrator');
select pg_temp.logout();
select pg_temp.as_device('dc-user', 'dc_agent', 'agent');
select is((select count(*)::int from chalito.brain_keys), 0, 'agents don''t see brain keys');
select pg_temp.logout();

set local role chalito_gateway;
select throws_ok($$select * from chalito.brain_keys$$, '42501', null, 'gateway: no access to brain keys');
reset role;

set local role chalito_server;
update chalito.brain_keys set cloud = false where provider = 'openai';
reset role;
select is((select count(*)::int from chalito_private.brain_key_wrapped), 0, 'cloud off: the wrapped copy is deleted');
select is((select count(*)::int from chalito.brain_keys), 1, 'the device-sealed copy stays');

select * from finish();
rollback;
