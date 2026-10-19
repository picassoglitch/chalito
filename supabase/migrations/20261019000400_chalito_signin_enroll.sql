-- Owner decision 2026-10-19 ("sign-in alone"): signing in with the Chalyb account on a device
-- approves it (POST /v1/devices/signin). Agents trust those clients from this directory.
do $$
declare c text;
begin
  -- The original check was inline (auto-named): drop whichever check covers enrolled_via.
  for c in
    select conname from pg_constraint
    where conrelid = 'chalito.devices'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%enrolled_via%'
  loop
    execute format('alter table chalito.devices drop constraint %I', c);
  end loop;
end $$;
alter table chalito.devices
  add constraint devices_enrolled_via_check
  check (enrolled_via in ('first_client', 'endorsement', 'pairing', 'recovery', 'sign_in'));
