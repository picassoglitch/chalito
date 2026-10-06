-- Co-members see each other's custom companions in rooms (owner decision 2026-10-05).
--
-- A custom card lives privately in the avatar bucket (avatars/<owner>/<asset_id>/); companions.asset_id
-- is server-only and companion_directory doesn't carry it. The api signs short-lived read URLs for a
-- room member's card (GET /v1/avatar/rooms/:roomId/cards), and only for a caller who is a member of
-- that same room right now: the same rule as policy companion_directory_co_members (R-L4). A leave,
-- a removal or a dissolve deletes the room_members row, so the next read gets nothing; URLs already
-- handed out expire on their own (15 minutes).
--
-- Server-only (chalito_server): clients never read asset ids or manifests of other owners directly.

create or replace function chalito_private.room_member_cards(p_uid text, p_room text)
returns table (companion_id text, owner text, asset_id text, manifest jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select m.companion_id, m.uid::text, c.asset_id, a.manifest
  from chalito.room_members me
  join chalito.room_members m on m.room_id = me.room_id
  join chalito.companions c on c.owner = m.uid and c.companion_id = m.companion_id
  join chalito.avatar_creations a on a.asset_id = c.asset_id and a.owner = c.owner and a.status = 'succeeded'
  where me.room_id = p_room
    and me.uid = p_uid
    and c.asset_id is not null
  order by m.companion_id
$$;

revoke all on function chalito_private.room_member_cards(text, text) from public, anon, authenticated, service_role;
grant execute on function chalito_private.room_member_cards(text, text) to chalito_server;
