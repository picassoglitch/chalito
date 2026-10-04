-- Shared HTTP rate buckets (M15): the Cloud Run services' global caps for expensive or abusable
-- routes (enrolment, pairing and endorse codes, recovery, phone verification, OAuth registration,
-- SSO), held in Postgres so the limit spans every instance. Per-instance limits stay in memory
-- (@chalito/guard). key_hash = sha256(route group + client IP): no raw addresses are stored.
create table chalito_private.http_rate_buckets (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  tokens numeric not null,
  updated_at timestamptz not null
);
create index http_rate_buckets_updated_idx on chalito_private.http_rate_buckets (updated_at);

alter table chalito_private.http_rate_buckets enable row level security;
revoke all on chalito_private.http_rate_buckets from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.http_rate_buckets to chalito_server;
create policy server_all on chalito_private.http_rate_buckets for all to chalito_server using (true) with check (true);

-- A bucket untouched for an hour is full again; drop it.
select cron.schedule(
  'chalito-http-rate-buckets-purge',
  '*/15 * * * *',
  $$delete from chalito_private.http_rate_buckets where updated_at < now() - interval '1 hour'$$
);
