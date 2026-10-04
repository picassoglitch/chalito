-- Schema the notifier and the api phone routes need, as agreed with -8d (who owns
-- supabase/migrations and ships the real migration). NOT a migration: it documents the shapes
-- src/postgres-store.ts and apps/api/src/phone/postgres.ts use, and the pg tests apply it to a
-- scratch database when the migration isn't there yet.

alter table chalito.users
  -- null: default quiet hours (escalation.yaml); {"off": true}: none; {"start":"HH:MM","end":"HH:MM"}.
  add column if not exists quiet_hours jsonb,
  add column if not exists phone_e164 text,
  add column if not exists phone_country text,
  add column if not exists phone_verified_at timestamptz,
  add column if not exists charges_notice_ack_at timestamptz,
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists calls_enabled boolean not null default false,
  -- null: the country default (SMS off by default for MX).
  add column if not exists sms_enabled boolean,
  add column if not exists l4_quiet_override text[] not null default '{}';
create unique index if not exists users_verified_phone_key on chalito.users (phone_e164) where phone_verified_at is not null;

create table if not exists chalito_private.notification_ladders (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  coalesce_key text not null check (char_length(coalesce_key) <= 128),
  nid chalito.id not null,
  state text not null check (state in ('pending', 'acked', 'snoozed', 'expired', 'done')),
  ladder jsonb not null,
  next_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner, coalesce_key)
);
create index if not exists notification_ladders_owner_nid_idx on chalito_private.notification_ladders (owner, nid);

create table if not exists chalito_private.notification_sends (
  id bigint generated always as identity primary key,
  owner chalito.id not null references chalito.users (id) on delete cascade,
  nid chalito.id not null,
  coalesce_key text,
  channel text not null check (channel in ('push', 'whatsapp', 'call', 'sms', 'desktop')),
  provider_ref text,
  status text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists notification_sends_owner_created_idx on chalito_private.notification_sends (owner, created_at);

create table if not exists chalito.push_subscriptions (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  device_id chalito.id not null,
  endpoint text not null check (endpoint like 'https://%' and char_length(endpoint) <= 2048),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0,
  primary key (owner, device_id, endpoint)
);

alter table chalito_private.notification_ladders enable row level security;
alter table chalito_private.notification_sends enable row level security;
alter table chalito.push_subscriptions enable row level security;

grant select, insert, update on chalito_private.notification_ladders to chalito_server;
grant select, insert, update on chalito_private.notification_sends to chalito_server;
grant usage on all sequences in schema chalito_private to chalito_server;
grant select, update (last_ok_at, failures), delete on chalito.push_subscriptions to chalito_server;
grant update (phone_e164, phone_country, phone_verified_at, charges_notice_ack_at, whatsapp_opt_in, calls_enabled, sms_enabled)
  on chalito.users to chalito_server;
do $$ begin
  create policy server_all on chalito_private.notification_ladders for all to chalito_server using (true) with check (true);
  create policy server_all on chalito_private.notification_sends for all to chalito_server using (true) with check (true);
  create policy server_all on chalito.push_subscriptions for all to chalito_server using (true) with check (true);
exception when duplicate_object then null; end $$;
