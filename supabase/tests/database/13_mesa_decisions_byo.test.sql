-- Migration 002300: the orchestrator can only CREATE pending Mesa decisions; nothing resolves one on
-- insert. Only chalito_server can call resolve_orchestrator_decision (after it verified the
-- signature), which re-checks the rows and can never touch an agent's approval. BYO brain keys:
-- sealed copy readable by the person's clients, KMS-wrapped copy server-only, gone when cloud is off.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

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
create function pg_temp.decision(aid text, signer text, allow boolean, target text default 'orchestrator',
  request text default 't_1') returns jsonb
language sql as $$
  select jsonb_build_object('ctx', 'chalito.decision.v1', 'signerDeviceId', signer, 'sig', 'x',
    'body', jsonb_build_object('v', 1, 'aid', aid, 'requestId', request, 'uid', 'dc-user', 'targetDeviceId', target,
                               'allow', allow, 'choice', 1)) $$;

insert into chalito.tenants (id) values ('dc-user');
insert into chalito.users (id, tenant_id) values ('dc-user', 'dc-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('dc-user', 'dc_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('dc_phone')::uuid),
  ('dc-user', 'dc_tablet', 'client', 'phone', 'ios', 'Tablet', 'p', 'p', 'f', 'endorsement', md5('dc_tablet')::uuid),
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

-- ---------------------------------------------------------------- the person answers; nothing resolves on insert
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('dc-user', 'apr_m1', 'dc_phone', '{"garbage": true}')$$,
  'client: a stolen token can insert garbage (RLS can''t check a signature)');
select throws_ok($$select chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_phone')$$, '42501', null,
  'client: can''t call the resolve function');
select pg_temp.logout();
select is((select status from chalito.approvals where aid = 'apr_m1'), 'pending', 'garbage resolves nothing on insert');

set local role chalito_gateway;
select throws_ok($$select chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_phone')$$, '42501', null,
  'gateway: can''t call it either');
reset role;

-- ---------------------------------------------------------------- only the orchestrator, after verifying
set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_phone'), null,
  'server: a malformed answer is refused by the SQL re-check too');
reset role;

select pg_temp.as_device('dc-user', 'dc_tablet', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
values ('dc-user', 'apr_m1', 'dc_tablet', pg_temp.decision('apr_m1', 'dc_tablet', false));
select pg_temp.logout();
update chalito.devices set revoked = true where device_id = 'dc_tablet';
set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_tablet'), null,
  'server: a revoked signer''s answer doesn''t resolve');
reset role;
update chalito.devices set revoked = false where device_id = 'dc_tablet';
set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_tablet'), 'denied',
  'server: a well-formed answer from an active client resolves it');
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m1', 'dc_tablet'), null,
  'server: and only once');
reset role;
select is((select status || '/' || reason from chalito.approvals where aid = 'apr_m1'), 'denied/signed:dc_tablet:choice=1',
  'status and reason record the signer and choice');

-- An agent's approval can never be touched through it, whatever the answer row says.
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
values ('dc-user', 'apr_agent', 'dc_phone', pg_temp.decision('apr_agent', 'dc_phone', true, 'orchestrator', 'r'));
select pg_temp.logout();
set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_agent', 'dc_phone'), null,
  'server: an agent approval is untouchable through the function');
reset role;
select is((select status from chalito.approvals where aid = 'apr_agent'), 'pending', 'the agent approval stays pending');

-- A request-id mismatch doesn't resolve.
set local role chalito_server;
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values ('dc-user', 'apr_m2', 'orchestrator', 'm_1', 't_5', 'decision', 'MED', 'client:dc_phone', false, '{}', now() + interval '10 minutes');
reset role;
select pg_temp.as_device('dc-user', 'dc_phone', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
values ('dc-user', 'apr_m2', 'dc_phone', pg_temp.decision('apr_m2', 'dc_phone', true, 'orchestrator', 't_other'));
select pg_temp.logout();
set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('dc-user', 'apr_m2', 'dc_phone'), null,
  'server: an answer for another request doesn''t resolve');
reset role;

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
