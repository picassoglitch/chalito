-- Usage outbox (ADR 0013/0016, D-029): every managed cost is written here in the same
-- transaction as the work, then drained to the Chalyb hub's POST /usage with backoff.
-- Idempotent on source_id (the hub dedupes on (engine, source_id) too). Nothing is dropped:
-- a non-retriable 4xx marks the row `dead` and alerts. Replaces the M0 stub (no data, no grants).

drop table if exists chalito_private.usage_outbox;

create table chalito_private.usage_outbox (
  id bigint generated always as identity primary key,
  -- No FK: usage for a deleted account must still reach the hub.
  owner chalito.id not null,
  source_id text not null unique check (char_length(source_id) between 1 and 200),
  -- A HubUsageEvent (packages/protocol billing.ts): kind, amount, cost_usd_micros, occurred_at, …
  event jsonb not null check (jsonb_typeof(event) = 'object' and event ? 'cost_usd_micros'),
  status text not null default 'pending' check (status in ('pending', 'sent', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index usage_outbox_due_idx on chalito_private.usage_outbox (next_attempt_at, id) where status = 'pending';
create index usage_outbox_dead_idx on chalito_private.usage_outbox (created_at) where status = 'dead';
create index usage_outbox_owner_idx on chalito_private.usage_outbox (owner, created_at);

alter table chalito_private.usage_outbox enable row level security;
revoke all on chalito_private.usage_outbox from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.usage_outbox to chalito_server;
create policy server_all on chalito_private.usage_outbox for all to chalito_server using (true) with check (true);

-- Sent rows are kept 30 days for reconciliation; dead rows stay until someone resolves them.
select cron.schedule(
  'chalito-usage-outbox-purge',
  '29 4 * * *',
  $$delete from chalito_private.usage_outbox where status = 'sent' and sent_at < now() - interval '30 days'$$
);
