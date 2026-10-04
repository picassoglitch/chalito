-- Migration 003510: several decision attempts per device per approval, still insert-only. A
-- rejected row no longer blocks the same device's valid one; at most 5 attempts per device per
-- approval; nothing is ever overwritten; the orchestrator resolves with the exact row it verified.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

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
create function pg_temp.decision(aid text, signer text, allow boolean) returns jsonb language sql as $$
  select jsonb_build_object('ctx', 'chalito.decision.v1', 'signerDeviceId', signer, 'sig', 'x',
    'body', jsonb_build_object('v', 1, 'aid', aid, 'requestId', 't_1', 'uid', 'da-user',
                               'targetDeviceId', 'orchestrator', 'allow', allow)) $$;

insert into chalito.tenants (id) values ('da-user');
insert into chalito.users (id, tenant_id) values ('da-user', 'da-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('da-user', 'da_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('da_phone')::uuid),
  ('da-user', 'da_tablet', 'client', 'phone', 'ios', 'Tablet', 'p', 'p', 'f', 'endorsement', md5('da_tablet')::uuid);
set local role chalito_server;
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values
  ('da-user', 'apr_1', 'orchestrator', 'm_1', 't_1', 'decision', 'MED', 'client:da_phone', false, '{}', now() + interval '10 minutes'),
  ('da-user', 'apr_2', 'orchestrator', 'm_1', 't_1', 'decision', 'MED', 'client:da_phone', false, '{}', now() + interval '10 minutes');
reset role;

select col_is_pk('chalito', 'approval_decisions', array['owner', 'aid', 'signer_device_id', 'id'],
  'each attempt is its own row');

-- ---------------------------------------------------------------- a rejected row, then a valid one
select pg_temp.as_device('da-user', 'da_phone', 'client');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('da-user', 'apr_1', 'da_phone', '{"garbage": true}')$$, 'a first attempt (one the orchestrator will reject)');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('da-user', 'apr_1', 'da_phone', pg_temp.decision('apr_1', 'da_phone', true))$$,
  'the same device''s next attempt is stored too');
select is((select count(*)::int from chalito.approval_decisions where aid = 'apr_1'), 2, 'both rows, in order');
-- Insert-only: no attempt can be changed or removed, by its own device or anyone.
select throws_ok($$update chalito.approval_decisions set decision = '{"x": 1}' where aid = 'apr_1'$$, '42501', null,
  'a valid row can''t be overwritten');
select throws_ok($$delete from chalito.approval_decisions where aid = 'apr_1'$$, '42501', null, 'or deleted');
select pg_temp.logout();

set local role chalito_server;
select is(chalito_private.resolve_orchestrator_decision('da-user', 'apr_1', 'da_phone',
  (select id from chalito.approval_decisions where aid = 'apr_1' and decision ? 'garbage')), null,
  'the rejected row resolves nothing');
select is(chalito_private.resolve_orchestrator_decision('da-user', 'apr_1', 'da_tablet',
  (select id from chalito.approval_decisions where aid = 'apr_1' and decision ->> 'ctx' = 'chalito.decision.v1')), null,
  'a row id only counts for its own signer');
select is(chalito_private.resolve_orchestrator_decision('da-user', 'apr_1', 'da_phone',
  (select id from chalito.approval_decisions where aid = 'apr_1' and decision ->> 'ctx' = 'chalito.decision.v1')),
  'approved', 'the verified (valid) row resolves it');
reset role;

-- ---------------------------------------------------------------- at most 5 attempts per device
select pg_temp.as_device('da-user', 'da_phone', 'client');
insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
select 'da-user', 'apr_2', 'da_phone', jsonb_build_object('n', g) from generate_series(1, 5) g;
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('da-user', 'apr_2', 'da_phone', '{"n": 6}')$$, '23514', null, 'a 6th attempt from the same device is refused');
select pg_temp.logout();
select pg_temp.as_device('da-user', 'da_tablet', 'client');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('da-user', 'apr_2', 'da_tablet', '{"n": 1}')$$, 'the cap is per device');
select pg_temp.logout();

select * from finish();
rollback;
