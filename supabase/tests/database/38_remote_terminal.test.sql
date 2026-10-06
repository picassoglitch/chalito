-- Migration 20261006000400: terminal approvals (HIGH + step-up only) and the terminal.* audit
-- category.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into chalito.tenants (id) values ('rt-user');
insert into chalito.users (id, tenant_id) values ('rt-user', 'rt-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('rt-user', 'rt_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing');
insert into chalito.sessions (owner, sid, device_id) values ('rt-user', 'rt_t1', 'rt_agent');

select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rt-user', 'rt_a1', 'rt_agent', 'rt_t1', 'r1', 'terminal', 'HIGH', 'client:c1', true, '{}', now() + interval '10 minutes')$$,
  'a terminal approval is accepted'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rt-user', 'rt_a2', 'rt_agent', 'rt_t1', 'r2', 'terminal', 'HIGH', 'client:c1', false, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'never without step-up'
);
select lives_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rt-user', 'rt_a3', 'rt_agent', 'rt_t1', 'r3', 'computer_control', 'HIGH', 'local', true, '{}', now() + interval '10 minutes')$$,
  'computer_control approvals still accepted'
);
select throws_ok(
  $$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
    values ('rt-user', 'rt_a4', 'rt_agent', 'rt_t1', 'r4', 'shell', 'HIGH', 'local', true, '{}', now() + interval '10 minutes')$$,
  '23514', null, 'unknown kinds are still refused'
);
select is(chalito.audit_category('terminal.opened'), 'terminal', 'terminal.* has its own category');
select is(chalito.audit_category('computer.action'), 'computer', 'other categories unchanged');

select * from finish();
rollback;
