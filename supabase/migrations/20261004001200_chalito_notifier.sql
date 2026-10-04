-- M6 notifier state (shapes from -41, apps/notifier). Ladders and send history are server only;
-- push subscriptions are written by the owning client device and read by the notifier.

-- ---------------------------------------------------------------- escalation ladders
-- `ladder` is the whole @chalito/escalation Ladder (metadata only); the engine owns its shape.
-- state, nid and next_at are mirrored for queries. Cloud Tasks schedules, so nothing polls next_at.
create table chalito_private.notification_ladders (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  coalesce_key text not null check (char_length(coalesce_key) <= 128),
  nid chalito.id not null,
  state text not null check (state in ('pending', 'acked', 'snoozed', 'expired', 'done')),
  ladder jsonb not null,
  next_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner, coalesce_key)
);
create index notification_ladders_owner_nid_idx on chalito_private.notification_ladders (owner, nid);

-- ---------------------------------------------------------------- send history (caps)
-- One row per whatsapp/call/sms send, written under the per-owner decision lock before sending.
create table chalito_private.notification_sends (
  id bigint generated always as identity primary key,
  owner chalito.id not null references chalito.users (id) on delete cascade,
  nid chalito.id not null,
  coalesce_key text not null check (char_length(coalesce_key) <= 128),
  channel text not null check (channel in ('push', 'whatsapp', 'call', 'sms', 'desktop')),
  provider_ref text,
  status text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index notification_sends_owner_created_idx on chalito_private.notification_sends (owner, created_at);

-- ---------------------------------------------------------------- web push subscriptions
create table chalito.push_subscriptions (
  owner chalito.id not null,
  device_id chalito.id not null,
  endpoint text not null check (endpoint like 'https://%' and char_length(endpoint) <= 2048),
  p256dh text not null check (char_length(p256dh) <= 256),
  auth text not null check (char_length(auth) <= 64),
  user_agent text check (char_length(user_agent) <= 512),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0,
  primary key (owner, device_id, endpoint),
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade
);

-- At most 5 subscriptions per device (client inserts; the server isn't capped).
create or replace function chalito_private.push_subscription_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('role', true), '') = 'authenticated'
     and (select count(*) from chalito.push_subscriptions p
          where p.owner = new.owner and p.device_id = new.device_id) >= 5 then
    raise exception 'chalito: at most 5 push subscriptions per device' using errcode = 'PT429';
  end if;
  return new;
end
$$;
create trigger push_subscription_cap before insert on chalito.push_subscriptions
  for each row execute function chalito_private.push_subscription_cap();

alter table chalito_private.notification_ladders enable row level security;
alter table chalito_private.notification_sends enable row level security;
alter table chalito.push_subscriptions enable row level security;

-- The owning active client manages its own device's subscriptions; it never reads them back.
-- (Postgres applies SELECT policies to a DELETE's WHERE, so the device may see its own rows' keys.)
create policy push_subscriptions_client_insert on chalito.push_subscriptions for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_client()));
create policy push_subscriptions_client_keys on chalito.push_subscriptions for select to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_client()));
create policy push_subscriptions_client_delete on chalito.push_subscriptions for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_client()));

create policy server_all on chalito_private.notification_ladders for all to chalito_server using (true) with check (true);
create policy server_all on chalito_private.notification_sends for all to chalito_server using (true) with check (true);
create policy server_all on chalito.push_subscriptions for all to chalito_server using (true) with check (true);

revoke all on chalito_private.notification_ladders, chalito_private.notification_sends, chalito.push_subscriptions
  from public, anon, authenticated, service_role;
revoke all on function chalito_private.push_subscription_cap() from public, anon, authenticated, service_role;

grant insert (owner, device_id, endpoint, p256dh, auth, user_agent) on chalito.push_subscriptions to authenticated;
grant select (owner, device_id, endpoint) on chalito.push_subscriptions to authenticated;
grant delete on chalito.push_subscriptions to authenticated;

grant select, insert, update, delete on chalito_private.notification_ladders to chalito_server;
grant select, insert, update, delete on chalito_private.notification_sends to chalito_server;
grant select, delete, update (last_ok_at, failures) on chalito.push_subscriptions to chalito_server;

-- ---------------------------------------------------------------- retention
-- Send history: 3 days is enough for the caps (they use the user's local day; the notifier loads 48 h).
select cron.schedule(
  'chalito-notification-sends',
  '41 * * * *',
  $$delete from chalito_private.notification_sends where created_at < now() - interval '3 days'$$
);
