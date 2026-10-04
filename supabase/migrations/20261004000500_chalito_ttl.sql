-- TTL: Postgres has no native TTL (Firestore had TTL policies on `expireAt`). Expired rows are
-- already invisible through RLS (`expires_at > now()` in the read policies); this job deletes them.
-- Supabase Cron is pg_cron (docs/guides/cron). On the shared hub project, enabling the extension
-- is a project-wide change (ADR 0017 §Risks).

create extension if not exists pg_cron with schema pg_catalog;

create or replace function chalito_private.purge_expired(batch integer default 5000)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Batched so one run stays short even after downtime; the next minute picks up the rest.
  delete from chalito.pairing_codes where ctid in
    (select ctid from chalito.pairing_codes where expires_at <= now() limit batch);
  delete from chalito.commands where ctid in
    (select ctid from chalito.commands where expires_at <= now() limit batch);
  delete from chalito.session_events where ctid in
    (select ctid from chalito.session_events where expires_at <= now() limit batch);
  delete from chalito.call_lines where ctid in
    (select ctid from chalito.call_lines where expires_at <= now() limit batch);
  delete from chalito_private.sso_tokens where ctid in
    (select ctid from chalito_private.sso_tokens where expires_at <= now() limit batch);
  delete from chalito_private.device_nonces where ctid in
    (select ctid from chalito_private.device_nonces where expires_at <= now() limit batch);
end
$$;
revoke execute on function chalito_private.purge_expired(integer) from public;

select cron.schedule('chalito-purge-expired', '* * * * *', 'select chalito_private.purge_expired()');

-- cron.job_run_details is never cleaned automatically. Only Chalito's own jobs' history is
-- touched; the hub's jobs are not ours to prune.
select cron.schedule(
  'chalito-cron-history',
  '17 3 * * 0',
  $$delete from cron.job_run_details
    where end_time < now() - interval '7 days'
      and jobid in (select jobid from cron.job where jobname like 'chalito-%')$$
);
