-- Monthly caps (voice minutes, paid channels) are summed from the usage outbox since the start of
-- the local month. Purging sent rows after 30 days could drop the first day of a 31-day month
-- before it ends, undercounting the cap (R-L9). Keep sent rows 45 days.
select cron.schedule(
  'chalito-usage-outbox-purge',
  '29 4 * * *',
  $$delete from chalito_private.usage_outbox where status = 'sent' and sent_at < now() - interval '45 days'$$
);
