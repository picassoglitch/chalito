-- Beta security review (docs/reviews/beta-security-review.md), rooms:
--   R-L4: revoked devices still read the owner's companion_directory rows.
--   R-L6: a member could overwrite another member's sealed room key for the same epoch.

drop policy companion_directory_co_members on chalito.companion_directory;
create policy companion_directory_co_members on chalito.companion_directory for select to authenticated
  using ((owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()))
         or exists (select 1 from chalito.room_members theirs
                    where theirs.companion_id = companion_directory.companion_id
                      and chalito_private.is_room_member(theirs.room_id)));

-- A wrapped key, once installed for (room, device, epoch), is never replaced: only a rotation
-- (a new epoch) installs new keys. A conflicting re-wrap is a no-op.
create or replace function chalito_private.room_put_keys(p_room text, p_companion text, p_epoch integer, p_wrapped jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m chalito.room_members;
  dev text;
  ct text;
begin
  select * into m from chalito.room_members where room_id = p_room and companion_id = p_companion;
  if not found then perform chalito_private.room_fail('PT404', 'member not found'); end if;
  if jsonb_typeof(p_wrapped) is distinct from 'object' then
    perform chalito_private.room_fail('22023', 'wrapped keys must be {deviceId: ct}');
  end if;
  for dev, ct in select key, value #>> '{}' from jsonb_each(p_wrapped) loop
    if not exists (select 1 from chalito.devices d where d.owner = m.uid and d.device_id = dev
                   and d.role = 'client' and not d.revoked) then
      perform chalito_private.room_fail('22023', 'keys go only to the member''s active client devices');
    end if;
    insert into chalito.room_member_keys (room_id, companion_id, uid, device_id, epoch, ct)
    values (p_room, p_companion, m.uid, dev, p_epoch, ct)
    on conflict (room_id, device_id, epoch) do nothing;
  end loop;
end
$$;
revoke all on function chalito_private.room_put_keys(text, text, integer, jsonb) from public, anon, authenticated, service_role;
