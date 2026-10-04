-- Rooms: the owner removes a member.
--
-- Owner only, and never the owner itself (a member leaves with room_leave; the owner dissolves).
-- Like a leave, the member row goes (its sealed keys cascade with it) and the room needs a new key
-- epoch before anyone posts again, so the removed member can't read anything new. The
-- room_members_kicked trigger (003600) tells the removed member's devices to close the channel;
-- the api audits the removal.

create or replace function chalito_private.room_remove_member(
  p_uid text, p_companion text, p_room text, p_target text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if r.owner_companion_id <> p_companion then
    perform chalito_private.room_fail('42501', 'only the owner removes members');
  end if;
  if p_target = p_companion then
    perform chalito_private.room_fail('22023', 'the owner dissolves the room instead of removing itself');
  end if;
  perform pg_advisory_xact_lock(hashtext('chalito.room:' || p_room));
  delete from chalito.room_members where room_id = p_room and companion_id = p_target;
  if not found then perform chalito_private.room_fail('PT404', 'member not found'); end if;
  update chalito.rooms set needs_rotation = true where room_id = p_room;
end
$$;
revoke all on function chalito_private.room_remove_member(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.room_remove_member(text, text, text, text) to chalito_server;
