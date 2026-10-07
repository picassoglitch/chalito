-- "Eliminar mi personaje": the owner deletes a custom companion (owner decision 2026-10-05).
-- (apps/api src/avatar/routes.ts DELETE /v1/avatar/creations/:id, docs/RUNBOOK.md 6.8.)
--
-- The drawings are deleted from the bucket (avatars/<owner>/<asset_id>/, every object version); the
-- row stays, as status 'deleted', for billing and audit: what it cost, whether it was free, the hub
-- reservation, the attestation. Its manifest (the card's file list) goes with the drawings.
--
-- Nothing is given back:
--   - a paid creation stays billed (its reservation is settled as succeeded, even after deletion);
--   - a deleted free creation still counts as the free creation (avatar_creations_one_free covers
--     'deleted' too, and the api's free check does), and chalito_private.avatar_free_markers is not
--     touched by any of this.
--
-- Only a succeeded creation can be deleted (one in flight is refused by the api; failed and expired
-- ones never kept drawings), and a deleted one never comes back. If the companion wears it, the same
-- transaction clears companions.asset_id / expression_map: the companion is drawn from its roster
-- avatar again (companions.avatar never changed). companion_custom_card already refuses pointing a
-- companion at anything but a succeeded creation, and room_member_cards only hands out succeeded
-- ones, so a deleted card can't be worn or shown again.
--
-- files_deleted_at: when the api finished deleting the drawings. A row with status 'deleted' and no
-- files_deleted_at is a deletion whose storage step failed; the owner's retry (the endpoint is
-- idempotent) or an operator finishes it (RUNBOOK 6.8).

alter table chalito.avatar_creations
  add column deleted_at timestamptz,
  add column files_deleted_at timestamptz;

alter table chalito.avatar_creations drop constraint avatar_creations_status_check;
alter table chalito.avatar_creations
  add constraint avatar_creations_status_check
    check (status in ('awaiting_upload', 'queued', 'generating', 'succeeded', 'failed', 'expired', 'deleted')),
  add constraint avatar_creations_deleted_at check ((status = 'deleted') = (deleted_at is not null)),
  add constraint avatar_creations_files_deleted_at check (files_deleted_at is null or status = 'deleted');

-- A deleted free creation is still the free creation: deleting it never makes the next one free.
drop index chalito.avatar_creations_one_free;
create unique index avatar_creations_one_free on chalito.avatar_creations (owner)
  where free and status in ('awaiting_upload', 'queued', 'generating', 'succeeded', 'deleted');

-- Deletions whose drawings may still be in the bucket.
create index avatar_creations_files_pending_idx on chalito.avatar_creations (owner)
  where status = 'deleted' and files_deleted_at is null;

-- ================================================================ transitions
-- 'deleted' only from 'succeeded', and never left. On the way in: no manifest, a deleted_at.
create or replace function chalito_private.avatar_creation_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'deleted' and new.status is distinct from 'deleted' then
    raise exception 'chalito: a deleted creation stays deleted' using errcode = '23514';
  end if;
  if new.status = 'deleted' and old.status <> 'deleted' then
    if old.status <> 'succeeded' then
      raise exception 'chalito: only a succeeded creation can be deleted (was %)', old.status using errcode = '23514';
    end if;
    new.manifest := null;
    new.deleted_at := coalesce(new.deleted_at, now());
  end if;
  return new;
end
$$;

create trigger avatar_creations_status_guard
  before update of status on chalito.avatar_creations
  for each row execute function chalito_private.avatar_creation_status_guard();

revoke all on function chalito_private.avatar_creation_status_guard() from public, anon, authenticated, service_role;

-- The companion that wears a deleted card goes back to its roster avatar, in the same transaction.
create or replace function chalito_private.avatar_creation_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update chalito.companions
  set asset_id = null, expression_map = null
  where owner = new.owner and asset_id = new.asset_id;
  return null;
end
$$;

create trigger avatar_creations_deleted
  after update of status on chalito.avatar_creations
  for each row when (new.status = 'deleted' and old.status is distinct from 'deleted')
  execute function chalito_private.avatar_creation_deleted();

revoke all on function chalito_private.avatar_creation_deleted() from public, anon, authenticated, service_role;
