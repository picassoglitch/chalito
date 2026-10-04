-- Hourly sweep of expired pairing-watcher auth users (Option C: each pairing watcher is a
-- short-lived Supabase Auth user created by Chalito's API). Runs on the SHARED hub project, so it
-- is a hub sign-off item (supabase/hub/README.md).
--
-- Scoped so that no hub user and no device user can ever match. A user is deleted only if ALL hold:
--   * the email is in Chalito's reserved, non-routable pairing domain (@pairing.chalito.invalid);
--   * app_metadata.chalito.role = 'pairing' (server-set; users can't edit app_metadata);
--   * it is older than an hour (pairing codes live 5 minutes).

create or replace function chalito_private.sweep_pairing_watchers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from auth.users u
  where lower(u.email) like '%@pairing.chalito.invalid'
    and u.raw_app_meta_data -> 'chalito' ->> 'role' = 'pairing'
    and u.created_at < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end
$$;
revoke execute on function chalito_private.sweep_pairing_watchers() from public, anon, authenticated, service_role;

select cron.schedule('chalito-pairing-watchers', '23 * * * *', 'select chalito_private.sweep_pairing_watchers()');
