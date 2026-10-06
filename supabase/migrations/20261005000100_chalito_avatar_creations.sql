-- Custom companions from a photo (apps/api src/avatar, apps/avatar-jobs src/creation.ts).
--
-- The owner uploads a photo of themselves; the avatar job turns it into the roster's five drawings
-- (neutral, happy, sad, surprised, tired) in the Chalito chibi style and writes a card under
-- avatars/<owner>/<asset_id>/. The photo is only a reference: the job deletes it in every outcome.
--
-- Billing: the first creation per owner is free; every later one is admitted through the hub before
-- any work (reservation_id) and, on success only, billed at the real provider cost through an
-- image.generations usage event (chalito_private.usage_outbox, same transaction as the status).
-- The hub adds its margin. cost_usd_micros here is the internal record of what the provider cost,
-- billed or not (free creations and failures included).
--
-- Race safety:
--   - one creation in flight per owner (partial unique index);
--   - at most one free creation in flight or succeeded per owner (partial unique index), so the free
--     credit is consumed only by a success and a failed free attempt gives it back.
-- creation_id is the client's idempotency key: retrying a start never admits or creates twice.

create table chalito.avatar_creations (
  creation_id text primary key check (creation_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  owner chalito.id not null references chalito.users (id) on delete cascade,
  -- Lowercase so the asset id is also a valid path segment everywhere (avatars/<owner>/<asset_id>/).
  asset_id text not null unique check (asset_id ~ '^[a-z0-9]{8,64}$'),
  status text not null default 'awaiting_upload'
    check (status in ('awaiting_upload', 'queued', 'generating', 'succeeded', 'failed', 'expired')),
  free boolean not null,
  -- The hub admission of a paid creation; settled (succeeded / cancelled) once it is terminal.
  reservation_id uuid,
  est_tokens integer check (est_tokens >= 0),
  settled_at timestamptz,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  failure text check (failure in ('rejected', 'refused', 'provider', 'upload_missing', 'timeout')),
  -- Images the provider returned for this creation, and what they cost (µ$), billed or not.
  images integer not null default 0 check (images >= 0),
  cost_usd_micros bigint not null default 0 check (cost_usd_micros >= 0),
  -- The image.generations usage event's source_id (paid successes only).
  source_id text unique,
  -- The card the job wrote (card.json), for the client and companions.expression_map.
  manifest jsonb check (manifest is null or (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 16384)),
  upload_deadline timestamptz not null,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  check (free = (reservation_id is null)),
  check ((status = 'succeeded') = (manifest is not null)),
  check ((status = 'failed') = (failure is not null))
);
create unique index avatar_creations_one_active on chalito.avatar_creations (owner)
  where status in ('awaiting_upload', 'queued', 'generating');
create unique index avatar_creations_one_free on chalito.avatar_creations (owner)
  where free and status in ('awaiting_upload', 'queued', 'generating', 'succeeded');
create index avatar_creations_owner_idx on chalito.avatar_creations (owner, created_at desc);
-- Paid creations whose reservation the api still has to settle.
create index avatar_creations_unsettled_idx on chalito.avatar_creations (owner)
  where reservation_id is not null and settled_at is null;

alter table chalito.avatar_creations enable row level security;
revoke all on chalito.avatar_creations from public, anon, authenticated, service_role;
-- Owners read their own creations; only the api and the avatar job write.
grant select on chalito.avatar_creations to authenticated;
create policy avatar_creations_read on chalito.avatar_creations for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
grant select, insert, update on chalito.avatar_creations to chalito_server;
create policy server_all on chalito.avatar_creations for all to chalito_server using (true) with check (true);

-- ================================================================ the companion's custom card
-- companions.asset_id (server-only: no client column grant) points at a succeeded creation of the
-- same owner; expression_map is that card's emotion → drawing map. companions.avatar stays the
-- roster id: what co-members see in rooms and the fallback when the card can't load.
--
-- Picking a roster avatar (update_my_settings / the avatar column grant) means "not my custom one
-- any more": a change of avatar that doesn't set asset_id itself clears it.
create or replace function chalito_private.companion_custom_card()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.avatar is distinct from old.avatar and new.asset_id is not distinct from old.asset_id then
    new.asset_id := null;
    new.expression_map := null;
  end if;
  if new.asset_id is not null and new.asset_id is distinct from old.asset_id and not exists (
    select 1 from chalito.avatar_creations c
    where c.asset_id = new.asset_id and c.owner = new.owner and c.status = 'succeeded'
  ) then
    raise exception 'chalito: asset_id must be a succeeded creation of the same owner' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger companions_custom_card
  before update of avatar, asset_id on chalito.companions
  for each row execute function chalito_private.companion_custom_card();

revoke all on function chalito_private.companion_custom_card() from public, anon, authenticated, service_role;
