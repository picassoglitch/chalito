-- The hourly pairing-watcher sweep deletes only expired pairing-watcher auth users.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email, raw_app_meta_data, created_at) values
  ('00000000-0000-4000-8000-000000000001', 'w1@pairing.chalito.invalid',
   '{"provider": "chalito", "chalito": {"role": "pairing", "pairing_code": "c1"}}', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000000002', 'w2@pairing.chalito.invalid',
   '{"provider": "chalito", "chalito": {"role": "pairing", "pairing_code": "c2"}}', now() - interval '10 minutes'),
  -- A hub user, old, even with a lookalike email but no Chalito pairing claim.
  ('00000000-0000-4000-8000-000000000003', 'person@pairing.chalito.invalid',
   '{"provider": "email"}', now() - interval '30 days'),
  ('00000000-0000-4000-8000-000000000004', 'person@example.com',
   '{"provider": "email"}', now() - interval '30 days'),
  -- A device user (agent), old.
  ('00000000-0000-4000-8000-000000000005', 'dev@device.chalito.invalid',
   '{"provider": "chalito", "chalito": {"role": "agent", "owner": "u1", "device_id": "d1"}}', now() - interval '30 days'),
  -- Pairing role but outside the reserved domain: not swept.
  ('00000000-0000-4000-8000-000000000006', 'w6@example.com',
   '{"provider": "chalito", "chalito": {"role": "pairing", "pairing_code": "c6"}}', now() - interval '2 hours');

select is(chalito_private.sweep_pairing_watchers(), 1, 'sweep: exactly one user removed');
select ok(not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-000000000001'),
  'sweep: an expired pairing watcher is deleted');
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-8000-000000000002'),
  'sweep: a pairing watcher under an hour old is kept');
select is((select count(*)::int from auth.users where id in ('00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004')), 2, 'sweep: hub users are untouched, even in the reserved domain');
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-8000-000000000005'),
  'sweep: device users are untouched');
select is((select schedule from cron.job where jobname = 'chalito-pairing-watchers'), '23 * * * *',
  'sweep: scheduled hourly under pg_cron');

select * from finish();
rollback;
