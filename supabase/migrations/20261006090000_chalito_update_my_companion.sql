-- Renaming the companion from the web didn't stick (tester, 2026-10-06): after
-- create_my_companion, renames went through a direct UPDATE on chalito.companions, whose policy
-- (companions_client_update) needs a paired device session (active_client()). The person's own
-- session from the hub matched 0 rows, without an error, so the name was back to "Chalito" after a
-- reload. Settings are meant to work before this browser is paired (settings_caller(): the
-- person, or an active client), so the update gets the same RPC path as the create.
create or replace function chalito_private.update_my_companion(p_name text, p_avatar text, p_is_renamed boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o text := chalito_private.settings_caller();
  r chalito.companions%rowtype;
begin
  if o is null then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 40 then
    raise exception 'chalito: bad name' using errcode = '22023';
  end if;
  update chalito.companions
     set name = p_name, is_renamed = coalesce(p_is_renamed, false), avatar = p_avatar
   where owner = o
  returning * into r;
  if not found then
    raise exception 'chalito: no companion' using errcode = 'P0002';
  end if;
  return jsonb_build_object('companion_id', r.companion_id, 'name', r.name, 'is_renamed', r.is_renamed,
                            'avatar', r.avatar);
end
$$;

create or replace function chalito.update_my_companion(p_name text, p_avatar text, p_is_renamed boolean default false)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select chalito_private.update_my_companion(p_name, p_avatar, p_is_renamed) $$;

revoke all on function chalito_private.update_my_companion(text, text, boolean) from public, anon;
revoke all on function chalito.update_my_companion(text, text, boolean) from public, anon;
grant execute on function chalito_private.update_my_companion(text, text, boolean) to authenticated;
grant execute on function chalito.update_my_companion(text, text, boolean) to authenticated;
