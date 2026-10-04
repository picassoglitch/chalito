-- Store purchases (M8, D-030): cosmetics paid from the hub balance. The price goes to the hub as
-- a store.purchase usage event (cost_usd_micros = price in tokens × 4, "already a price") through
-- chalito_private.usage_outbox, in the same transaction as this row and the inventory row.
-- purchase_id is the client's idempotency key: retrying a purchase never charges twice.
create table chalito.purchases (
  purchase_id text primary key check (purchase_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  owner chalito.id not null references chalito.users (id) on delete cascade,
  cosmetic_id text not null check (cosmetic_id ~ '^[a-z0-9_]{1,64}$'),
  price_tokens integer not null check (price_tokens > 0),
  reservation_id uuid not null,
  -- The outbox/hub idempotency key of the store.purchase event.
  source_id text not null unique,
  created_at timestamptz not null default now()
);
create index purchases_owner_idx on chalito.purchases (owner, created_at desc);

alter table chalito.purchases enable row level security;
revoke all on chalito.purchases from public, anon, authenticated, service_role;
-- Owners read their own history; only the server writes (equipping and buying are server-only).
grant select on chalito.purchases to authenticated;
create policy purchases_read on chalito.purchases for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
grant select, insert on chalito.purchases to chalito_server;
create policy server_all on chalito.purchases for all to chalito_server using (true) with check (true);
