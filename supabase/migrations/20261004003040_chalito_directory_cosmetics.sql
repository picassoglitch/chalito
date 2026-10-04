-- The room scene shows each co-member's companion as it looks (M11 scene, M8 store): its roster
-- avatar and the cosmetics it wears. Both live in chalito.companion_directory, the only companion
-- data co-members can read (policy companion_directory_co_members, R-L4: room members, plus the
-- owner's own active devices). Cosmetics aren't secret.
--
-- The directory stays server-written: clients have SELECT only, and a security-definer trigger on
-- chalito.companions keeps each companion's row in step: display name, avatar (a roster id),
-- equipped item ids. Equipping and unequipping update companions.equipped (POST /v1/store/equip,
-- server only), so the same trigger covers them.

alter table chalito.companion_directory
  add column equipped text[] not null default '{}'
    check (cardinality(equipped) <= 6 and array_to_string(equipped, ',') ~ '^([a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$');

-- companions.equipped is {"<slot>": "<cosmetic id>"}; the directory gets the ids, in slot order.
create or replace function chalito_private.equipped_ids(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(v order by k), '{}')
  from jsonb_each_text(coalesce(p, '{}'::jsonb)) as e(k, v)
  where v ~ '^[a-z0-9_]{1,64}$'
$$;

create or replace function chalito_private.sync_companion_directory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into chalito.companion_directory (companion_id, owner, display_name, is_renamed, avatar_thumb, equipped)
  values (new.companion_id, new.owner, left(new.name, 40), new.is_renamed, new.avatar, chalito_private.equipped_ids(new.equipped))
  on conflict (companion_id) do update
    set display_name = excluded.display_name,
        is_renamed = excluded.is_renamed,
        avatar_thumb = excluded.avatar_thumb,
        equipped = excluded.equipped;
  return null;
end
$$;
revoke all on function chalito_private.sync_companion_directory(), chalito_private.equipped_ids(jsonb)
  from public, anon, authenticated, service_role;

create trigger companion_directory_sync
  after insert or update of name, is_renamed, avatar, equipped on chalito.companions
  for each row execute function chalito_private.sync_companion_directory();

-- Backfill every existing companion.
insert into chalito.companion_directory (companion_id, owner, display_name, is_renamed, avatar_thumb, equipped)
select c.companion_id, c.owner, left(c.name, 40), c.is_renamed, c.avatar, chalito_private.equipped_ids(c.equipped)
from chalito.companions c
on conflict (companion_id) do update
  set display_name = excluded.display_name,
      is_renamed = excluded.is_renamed,
      avatar_thumb = excluded.avatar_thumb,
      equipped = excluded.equipped;

-- Server-written only (restated, in case a grant drifted): clients read, never write.
revoke insert, update, delete on chalito.companion_directory from authenticated, anon;
