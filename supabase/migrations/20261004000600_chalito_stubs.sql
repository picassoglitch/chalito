-- Stubs for the rest of brief §6. Each table exists so later milestones can migrate it in place,
-- but RLS is on with NO policies and NO client grants: deny-all until its milestone fills it in.
-- The Firestore rule each one must eventually port is noted beside it.

-- users/{uid}/... (owner-scoped)
create table chalito.mesas (            -- M9. read: member; create/update: active client
  owner chalito.id not null references chalito.users (id) on delete cascade,
  mid chalito.id not null, doc jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key (owner, mid));
create table chalito.mesa_turns (       -- M9. read: member; create: active client
  owner chalito.id not null, mid chalito.id not null, tid chalito.id not null,
  doc jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key (owner, mid, tid), foreign key (owner, mid) references chalito.mesas (owner, mid) on delete cascade);
create table chalito.records (          -- M11. read/create/delete: active client
  owner chalito.id not null references chalito.users (id) on delete cascade,
  rid chalito.id not null, doc jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key (owner, rid));
create table chalito.connections (      -- M5. read: member; write status fields only: active client; no secrets
  owner chalito.id not null references chalito.users (id) on delete cascade,
  provider text not null, doc jsonb not null default '{}', updated_at timestamptz not null default now(),
  primary key (owner, provider));
create table chalito.connectors (       -- M10. read: member; write: server
  owner chalito.id not null references chalito.users (id) on delete cascade,
  cid chalito.id not null, doc jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key (owner, cid));
create table chalito.reminders (        -- M11. read: member; write: server
  owner chalito.id not null references chalito.users (id) on delete cascade,
  rid chalito.id not null, doc jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key (owner, rid));
create table chalito.entitlements (     -- M12. read: member; write: server
  owner chalito.id not null references chalito.users (id) on delete cascade,
  id chalito.id not null, doc jsonb not null default '{}', updated_at timestamptz not null default now(),
  primary key (owner, id));

-- Rooms (M11): read by members (owner in memberUids); written through `api` only.
create table chalito.rooms (
  room_id chalito.id primary key, doc jsonb not null default '{}', created_at timestamptz not null default now());
create table chalito.room_members (
  room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  companion_id text not null, owner chalito.id not null, doc jsonb not null default '{}',
  primary key (room_id, companion_id));
create table chalito.room_events (
  room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  eid chalito.id not null, doc jsonb not null default '{}', t timestamptz not null default now(),
  expires_at timestamptz, primary key (room_id, eid));
create table chalito.room_invites (     -- server only
  invite_id chalito.id primary key, room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  doc jsonb not null default '{}', expires_at timestamptz not null);
create table chalito.companion_directory ( -- readable only by co-members (M11)
  companion_id text primary key, owner chalito.id not null, doc jsonb not null default '{}');

-- Catalog (M8/M12): public read, server write.
create table chalito.assets (asset_id chalito.id primary key, doc jsonb not null default '{}');
create table chalito.cosmetics (cosmetic_id chalito.id primary key, doc jsonb not null default '{}');
create table chalito.drops (drop_id chalito.id primary key, doc jsonb not null default '{}');
create table chalito.plans (tier_id chalito.id primary key, doc jsonb not null default '{}');

-- Server only, never exposed (M12).
create table chalito_private.purchases (
  purchase_id chalito.id primary key, owner chalito.id not null, doc jsonb not null default '{}',
  created_at timestamptz not null default now());
create table chalito_private.subscriptions (
  owner chalito.id primary key, doc jsonb not null default '{}', updated_at timestamptz not null default now());
create table chalito_private.credit_ledger (
  owner chalito.id not null, entry_id chalito.id not null, doc jsonb not null default '{}',
  t timestamptz not null default now(), primary key (owner, entry_id));
create table chalito_private.credit_balance (
  owner chalito.id primary key, doc jsonb not null default '{}', updated_at timestamptz not null default now());
create table chalito_private.usage_outbox (
  owner chalito.id not null, id chalito.id not null, doc jsonb not null default '{}',
  created_at timestamptz not null default now(), primary key (owner, id));

alter table chalito.mesas enable row level security;
alter table chalito.mesa_turns enable row level security;
alter table chalito.records enable row level security;
alter table chalito.connections enable row level security;
alter table chalito.connectors enable row level security;
alter table chalito.reminders enable row level security;
alter table chalito.entitlements enable row level security;
alter table chalito.rooms enable row level security;
alter table chalito.room_members enable row level security;
alter table chalito.room_events enable row level security;
alter table chalito.room_invites enable row level security;
alter table chalito.companion_directory enable row level security;
alter table chalito.assets enable row level security;
alter table chalito.cosmetics enable row level security;
alter table chalito.drops enable row level security;
alter table chalito.plans enable row level security;
alter table chalito_private.purchases enable row level security;
alter table chalito_private.subscriptions enable row level security;
alter table chalito_private.credit_ledger enable row level security;
alter table chalito_private.credit_balance enable row level security;
alter table chalito_private.usage_outbox enable row level security;

-- Only these tables: the client grants on the core tables are left as they are.
revoke all on chalito.mesas, chalito.mesa_turns, chalito.records, chalito.connections, chalito.connectors,
  chalito.reminders, chalito.entitlements, chalito.rooms, chalito.room_members, chalito.room_events,
  chalito.room_invites, chalito.companion_directory, chalito.assets, chalito.cosmetics, chalito.drops,
  chalito.plans from public, anon, authenticated;
revoke all on chalito_private.purchases, chalito_private.subscriptions, chalito_private.credit_ledger,
  chalito_private.credit_balance, chalito_private.usage_outbox from public, anon, authenticated;

grant all on chalito.mesas, chalito.mesa_turns, chalito.records, chalito.connections, chalito.connectors,
  chalito.reminders, chalito.entitlements, chalito.rooms, chalito.room_members, chalito.room_events,
  chalito.room_invites, chalito.companion_directory, chalito.assets, chalito.cosmetics, chalito.drops,
  chalito.plans to service_role;
grant all on chalito_private.purchases, chalito_private.subscriptions, chalito_private.credit_ledger,
  chalito_private.credit_balance, chalito_private.usage_outbox to service_role;
