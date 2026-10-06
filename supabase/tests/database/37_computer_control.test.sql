-- Migration 20261006000200: computer_control approvals (HIGH + step-up only) and the computer.*
-- audit category.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into chalito.tenants (id) values ('cc-user');
insert into chalito.users (id, tenant_id) values ('cc-user', 'cc-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('cc-user', 'cc_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing');
insert into chalito.sessions (owner, sid, device_id) values ('cc-user', 'cc_s1', 'cc_agent');

select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('cc-user', 'cc_a1', 'cc_agent', 'cc_s1', 'r1', 'computer_control', 'HIGH', 'local', true, '{}', now() + interval '10 minutes')$$,
  'a computer_control approval is accepted'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('cc-user', 'cc_a2', 'cc_agent', 'cc_s1', 'r2', 'computer_control', 'HIGH', 'local', false, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'never without step-up'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('cc-user', 'cc_a3', 'cc_agent', 'cc_s1', 'r3', 'computer', 'HIGH', 'local', true, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'unknown kinds are still refused'
);
select is(chalito.audit_category('computer.action'), 'computer', 'computer.* has its own category');
select is(chalito.audit_category('devmode.changed'), 'devmode', 'other categories unchanged');

select * from finish();
rollback;
