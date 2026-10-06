-- Migration 20261006000600: remote_view / remote_control / app_control / terminal approvals
-- (HIGH + step-up only); screen.* in its own audit category, every earlier category kept.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into chalito.tenants (id) values ('rs-user');
insert into chalito.users (id, tenant_id) values ('rs-user', 'rs-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('rs-user', 'rs_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing');
insert into chalito.sessions (owner, sid, device_id) values ('rs-user', 'rs_s1', 'rs_agent');

select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a1', 'rs_agent', 'rs_s1', 'r1', 'remote_view', 'HIGH', 'client:p', true, '{}', now() + interval '10 minutes')$$,
  'a remote_view approval is accepted'
);
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a2', 'rs_agent', 'rs_s1', 'r2', 'remote_control', 'HIGH', 'client:p', true, '{}', now() + interval '10 minutes')$$,
  'a remote_control approval is accepted'
);
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a3', 'rs_agent', 'rs_s1', 'r3', 'app_control', 'HIGH', 'local', true, '{}', now() + interval '10 minutes')$$,
  'an app_control approval is accepted'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a4', 'rs_agent', 'rs_s1', 'r4', 'remote_control', 'HIGH', 'client:p', false, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'never without step-up'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a5', 'rs_agent', 'rs_s1', 'r5', 'screen', 'HIGH', 'client:p', true, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'unknown kinds are still refused'
);
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rs-user', 'rs_a6', 'rs_agent', 'rs_s1', 'r6', 'terminal', 'HIGH', 'client:p', true, '{}', now() + interval '10 minutes')$$,
  'terminal approvals (20261006000400) are still accepted'
);
select is(chalito.audit_category('screen.ended'), 'screen', 'screen.* has its own category');
select is(chalito.audit_category('computer.action'), 'computer', 'computer.* unchanged');
select is(chalito.audit_category('terminal.opened'), 'terminal', 'terminal.* unchanged');
select has_view('chalito', 'audit_screen', 'the screen audit view exists');

select * from finish();
rollback;
