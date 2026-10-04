-- Channel opt-ins (calls, WhatsApp, SMS) are turned ON only by the api (POST /v1/phone/channels),
-- which checks the verified phone, the charges notice and whether calls to that country are
-- allowed. Clients may still turn them OFF through update_my_settings. The CHECK constraint from
-- 001100 stays as the last line of defence.
--
-- Also lets the owner change the companion's avatar after creation (the column CHECK applies).

alter function chalito_private.update_my_settings(jsonb) rename to update_my_settings_unguarded;

create function chalito_private.update_my_settings(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p) = 'object' and (
    coalesce((p ->> 'whatsapp_opt_in')::boolean, false) is true
    or coalesce((p ->> 'calls_enabled')::boolean, false) is true
    or coalesce((p ->> 'sms_enabled')::boolean, false) is true
  ) then
    raise exception 'chalito: channel opt-ins are turned on through the api (/v1/phone/channels)'
      using errcode = '42501';
  end if;
  return chalito_private.update_my_settings_unguarded(p);
end
$$;

revoke all on function chalito_private.update_my_settings(jsonb), chalito_private.update_my_settings_unguarded(jsonb)
  from public, anon, authenticated, service_role;
-- The invoker wrapper chalito.update_my_settings runs as the caller and calls the guard by name.
grant execute on function chalito_private.update_my_settings(jsonb) to authenticated;

grant update (avatar) on chalito.companions to authenticated;
