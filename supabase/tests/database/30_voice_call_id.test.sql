-- voice_sessions.call_id (migration 20261004003500): server-only, shape-checked, unique-open rule kept.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into chalito.tenants (id) values ('vc-user');
insert into chalito.users (id, tenant_id) values ('vc-user', 'vc-user');

grant usage on schema extensions to chalito_server;
set local role chalito_server;
insert into chalito_private.voice_sessions (source_id, owner, device_id, reservation_id, model, started_at, max_seconds)
values ('voice_' || repeat('a', 32), 'vc-user', 'dev_desk', gen_random_uuid(), 'gpt-realtime', now(), 600);
update chalito_private.voice_sessions set call_id = 'rtc_abc123' where source_id = 'voice_' || repeat('a', 32);
select is((select call_id from chalito_private.voice_sessions where source_id = 'voice_' || repeat('a', 32)), 'rtc_abc123',
  'server: records the provider call id');
select throws_ok($$update chalito_private.voice_sessions set call_id = 'rtc bad/../x' where owner = 'vc-user'$$, '23514', null,
  'server: only id-shaped call ids');
select throws_ok($$insert into chalito_private.voice_sessions (source_id, owner, device_id, reservation_id, model, started_at, max_seconds)
  values ('voice_' || repeat('b', 32), 'vc-user', 'dev_desk', gen_random_uuid(), 'm', now(), 600)$$, '23505', null,
  'server: still one open session per owner and channel');
reset role;

set local role authenticated;
select throws_ok($$select call_id from chalito_private.voice_sessions$$, '42501', null, 'rls: clients never read call ids');
reset role;
select ok(exists (select 1 from pg_indexes where indexname = 'voice_sessions_call_id'), 'index on call_id');

select * from finish();
rollback;
