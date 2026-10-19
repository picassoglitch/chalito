-- Migration 20261019000100: remembered coordinator rules (ADR 0025 §6). Only the owner's active
-- clients write, each only as itself; the owner's active devices read; nobody else sees them; no
-- updates; the envelope must agree with its row; at most 200 per owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;

create function pg_temp.rule(owner text, signer text, id text) returns jsonb language sql as $$
  select jsonb_build_object('ctx', 'chalito.coordrule.v1', 'signerDeviceId', signer, 'sig', repeat('A', 86),
    'body', jsonb_build_object('v', 1, 'ruleId', id, 'uid', owner, 'match', repeat('a', 64),
      'createdAt', 1, 'expiresAt', 2))
$$;

insert into chalito.tenants (id) values ('cr-a'), ('cr-b');
insert into chalito.users (id, tenant_id) values ('cr-a', 'cr-a'), ('cr-b', 'cr-b');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values
  ('cr-a', 'cr_a_phone', 'client', 'phone', 'ios', 'Phone', 'pk', 'p', 'f', 'first_client', md5('cr_a_phone')::uuid, false),
  ('cr-a', 'cr_a_web', 'client', 'web', 'web', 'Web', 'pk', 'p', 'f', 'endorsement', md5('cr_a_web')::uuid, false),
  ('cr-a', 'cr_a_old', 'client', 'web', 'web', 'Old', 'pk', 'p', 'f', 'endorsement', md5('cr_a_old')::uuid, true),
  ('cr-a', 'cr_a_desk', 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', md5('cr_a_desk')::uuid, false),
  ('cr-b', 'cr_b_phone', 'client', 'phone', 'ios', 'Phone', 'pk', 'p', 'f', 'first_client', md5('cr_b_phone')::uuid, false);

-- ================================================================ writes
select pg_temp.as_device('cr-a', 'cr_a_phone', 'client');
select lives_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0001', 'cr_a_phone', pg_temp.rule('cr-a', 'cr_a_phone', 'cr_rule0001'), now() + interval '1 day')$$,
  'an active client stores its own rule');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0002', 'cr_a_web', pg_temp.rule('cr-a', 'cr_a_web', 'cr_rule0002'), now() + interval '1 day')$$,
  '42501', null, 'a client can''t store a rule as another client');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0003', 'cr_a_phone', pg_temp.rule('cr-a', 'cr_a_web', 'cr_rule0003'), now() + interval '1 day')$$,
  '23514', null, 'the envelope''s signer must be the row''s');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0004', 'cr_a_phone', pg_temp.rule('cr-b', 'cr_a_phone', 'cr_rule0004'), now() + interval '1 day')$$,
  '23514', null, 'the envelope''s owner must be the row''s');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-b', 'cr_rule0005', 'cr_a_phone', pg_temp.rule('cr-b', 'cr_a_phone', 'cr_rule0005'), now() + interval '1 day')$$,
  '42501', null, 'nobody writes another owner''s rules');
select throws_ok($$update chalito.coord_rules set expires_at = now() + interval '1 year'$$,
  '42501', null, 'rules are never updated (renewing is a new row)');

select pg_temp.as_device('cr-a', 'cr_a_old', 'client');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0006', 'cr_a_old', pg_temp.rule('cr-a', 'cr_a_old', 'cr_rule0006'), now() + interval '1 day')$$,
  '42501', null, 'a revoked client can''t store one');

select pg_temp.as_device('cr-a', 'cr_a_desk', 'agent');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0007', 'cr_a_desk', pg_temp.rule('cr-a', 'cr_a_desk', 'cr_rule0007'), now() + interval '1 day')$$,
  '42501', null, 'an agent never writes a rule');

-- ================================================================ reads
select is((select count(*)::int from chalito.coord_rules), 1, 'the owner''s agent reads the owner''s rules');
select pg_temp.as_device('cr-a', 'cr_a_web', 'client');
select is((select count(*)::int from chalito.coord_rules), 1, 'and so do the owner''s other clients');
select pg_temp.as_device('cr-b', 'cr_b_phone', 'client');
select is((select count(*)::int from chalito.coord_rules), 0, 'another owner sees none');
select pg_temp.as_device('cr-a', 'cr_a_old', 'client');
select is((select count(*)::int from chalito.coord_rules), 0, 'a revoked device sees none');

-- ================================================================ delete and cap
select pg_temp.as_device('cr-a', 'cr_a_web', 'client');
delete from chalito.coord_rules where rule_id = 'cr_rule0001';
select is((select count(*)::int from chalito.coord_rules), 0, 'any of the owner''s clients removes a rule');

reset role;
insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  select 'cr-a', 'cr_cap' || lpad(i::text, 5, '0'), 'cr_a_phone',
         pg_temp.rule('cr-a', 'cr_a_phone', 'cr_cap' || lpad(i::text, 5, '0')), now() + interval '1 day'
  from generate_series(1, 200) i;
select pg_temp.as_device('cr-a', 'cr_a_phone', 'client');
select throws_ok($$insert into chalito.coord_rules (owner, rule_id, signer_device_id, rule, expires_at)
  values ('cr-a', 'cr_rule0201', 'cr_a_phone', pg_temp.rule('cr-a', 'cr_a_phone', 'cr_rule0201'), now() + interval '1 day')$$,
  '54000', null, 'at most 200 rules per owner');
select throws_ok($$select chalito_private.coord_rules_cap()$$, '42501', null, 'the cap trigger isn''t callable');

-- ================================================================ withdrawals
create function pg_temp.rev(owner text, signer text, id text) returns jsonb language sql as $$
  select jsonb_build_object('ctx', 'chalito.coordrule-revoke.v1', 'signerDeviceId', signer, 'sig', repeat('A', 86),
    'body', jsonb_build_object('v', 1, 'uid', owner, 'ruleId', id, 'revokedAt', 1))
$$;
select pg_temp.as_device('cr-a', 'cr_a_web', 'client');
select lives_ok($$insert into chalito.coord_rule_revocations (owner, rule_id, signer_device_id, revoke)
  values ('cr-a', 'cr_rule0001', 'cr_a_web', pg_temp.rev('cr-a', 'cr_a_web', 'cr_rule0001'))$$,
  'an active client withdraws a rule as itself');
select throws_ok($$insert into chalito.coord_rule_revocations (owner, rule_id, signer_device_id, revoke)
  values ('cr-a', 'cr_rule0009', 'cr_a_phone', pg_temp.rev('cr-a', 'cr_a_phone', 'cr_rule0009'))$$,
  '42501', null, 'not as another client');
select throws_ok($$delete from chalito.coord_rule_revocations$$, '42501', null, 'a client can''t delete a withdrawal');
select pg_temp.as_device('cr-a', 'cr_a_desk', 'agent');
select is((select count(*)::int from chalito.coord_rule_revocations), 1, 'the owner''s agent reads it');
select throws_ok($$insert into chalito.coord_rule_revocations (owner, rule_id, signer_device_id, revoke)
  values ('cr-a', 'cr_rule0010', 'cr_a_desk', pg_temp.rev('cr-a', 'cr_a_desk', 'cr_rule0010'))$$,
  '42501', null, 'an agent never writes one');
select throws_ok($$update chalito.coord_rule_revocations set revoke = revoke$$, '42501', null, 'never updated');
select pg_temp.as_device('cr-b', 'cr_b_phone', 'client');
select is((select count(*)::int from chalito.coord_rule_revocations), 0, 'another owner sees none');

select * from finish();
rollback;
