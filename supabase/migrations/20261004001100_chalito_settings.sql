-- M5 settings (-37), the user columns the M6 notifier reads (-41), and the companion/connection
-- rows onboarding creates. ADR 0017.
--
-- Pattern (S2 / D-051): client writes that need validation go through a SECURITY DEFINER worker
-- in chalito_private (not exposed) called by a thin SECURITY INVOKER wrapper in chalito (the RPC
-- PostgREST exposes). The worker re-derives the caller from the JWT and checks it itself.

create extension if not exists pgcrypto with schema extensions;

-- ================================================================ users: settings + phone
-- Quiet hours, tri-state (the notifier's shape): null = the default window from escalation.yaml,
-- {"off": true} = none, {"start": "HH:MM", "end": "HH:MM"} = custom.
create or replace function chalito_private.valid_quiet_hours(q jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select q is null
      or q = '{"off": true}'::jsonb
      or (jsonb_typeof(q) = 'object' and (q - array['start', 'end']) = '{}'::jsonb
          and coalesce(q ->> 'start', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          and coalesce(q ->> 'end', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
$$;

alter table chalito.users
  add column quiet_hours jsonb check (chalito_private.valid_quiet_hours(quiet_hours)),
  -- Sources whose L4 items may break quiet hours.
  add column l4_quiet_override text[] not null default '{}'
    check (cardinality(l4_quiet_override) <= 16 and array_to_string(l4_quiet_override, ',') ~ '^[a-z_,]*$'),
  add column privacy_mode text not null default 'private' check (privacy_mode in ('private', 'cloud_assist')),
  add column render_quality text not null default 'auto' check (render_quality in ('auto', 'bajo', 'medio', 'alto')),
  add column whatsapp_opt_in boolean not null default false,
  add column calls_enabled boolean not null default false,
  -- null = the country default (SMS is off by default for MX).
  add column sms_enabled boolean,
  add column prefs jsonb not null default '{}' check (jsonb_typeof(prefs) = 'object' and octet_length(prefs::text) <= 4096),
  -- What the user typed; the server sends a Twilio Verify code to it.
  add column phone_pending_e164 text check (phone_pending_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Written only by chalito_server after Twilio Verify succeeds.
  add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column phone_country text check (phone_country ~ '^[A-Z]{2}$'),
  add column phone_verified_at timestamptz,
  -- The "Pueden aplicar cargos" acknowledgement (server time).
  add column charges_notice_ack_at timestamptz,
  add constraint users_verified_phone_complete check ((phone_e164 is null) = (phone_verified_at is null)),
  -- Calls, SMS and WhatsApp only to a verified number whose charges notice was acknowledged.
  add constraint users_opt_ins_need_verified_phone check (
    not (whatsapp_opt_in or calls_enabled or coalesce(sms_enabled, false))
    or (phone_verified_at is not null and charges_notice_ack_at is not null)
  );
-- Inbound Twilio/WhatsApp webhooks map a number to one account: two accounts can't verify it.
create unique index users_verified_phone_key on chalito.users (phone_e164) where phone_verified_at is not null;

-- Phone columns aren't readable through the table: devices (agents) don't need them. The owner's
-- web session and client devices read them through chalito.get_my_settings().
revoke select on chalito.users from authenticated;
grant select (id, tenant_id, email, display_name, tier, status, status_at, locale, tz, call_briefing, created_at,
  last_sso_at, schema_version, quiet_hours, l4_quiet_override, privacy_mode, render_quality, whatsapp_opt_in,
  calls_enabled, sms_enabled, prefs) on chalito.users to authenticated;
-- The server (notifier, Twilio Verify) reads and writes everything, including the phone.
grant select, insert, update on chalito.users to chalito_server;

-- The person's own web session or one of their active client devices (not agents, not pairing).
create or replace function chalito_private.settings_caller()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select chalito.jwt_owner()
  where chalito.jwt_role() = 'user' or chalito_private.active_client()
$$;

create or replace function chalito_private.my_settings(p_owner text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'locale', u.locale, 'tz', u.tz, 'call_briefing', u.call_briefing, 'quiet_hours', u.quiet_hours,
    'l4_quiet_override', to_jsonb(u.l4_quiet_override), 'privacy_mode', u.privacy_mode,
    'render_quality', u.render_quality, 'whatsapp_opt_in', u.whatsapp_opt_in, 'calls_enabled', u.calls_enabled,
    'sms_enabled', u.sms_enabled, 'prefs', u.prefs, 'phone_pending_e164', u.phone_pending_e164,
    'phone_e164', u.phone_e164, 'phone_country', u.phone_country, 'phone_verified_at', u.phone_verified_at,
    'charges_notice_ack_at', u.charges_notice_ack_at)
  from chalito.users u where u.id = p_owner
$$;

create or replace function chalito_private.get_my_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o text := chalito_private.settings_caller();
begin
  if o is null then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  return chalito_private.my_settings(o);
end
$$;

create or replace function chalito_private.update_my_settings(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o text := chalito_private.settings_caller();
  k text;
  v jsonb;
  allowed constant text[] := array['locale', 'tz', 'call_briefing', 'quiet_hours', 'l4_quiet_override',
    'privacy_mode', 'render_quality', 'whatsapp_opt_in', 'calls_enabled', 'sms_enabled', 'prefs',
    'phone_pending_e164', 'charges_notice_ack_at'];
  bad constant text := '22023';
begin
  if o is null then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'chalito: settings must be a JSON object' using errcode = bad;
  end if;
  for k, v in select key, value from jsonb_each(p) loop
    if not k = any (allowed) then
      raise exception 'chalito: % is not a client setting', k using errcode = bad;
    end if;
    case k
      when 'locale' then
        if v #>> '{}' not in ('es', 'en') then raise exception 'chalito: bad locale' using errcode = bad; end if;
        update chalito.users set locale = v #>> '{}' where id = o;
      when 'tz' then
        if jsonb_typeof(v) <> 'string' or not exists (select 1 from pg_catalog.pg_timezone_names where name = v #>> '{}') then
          raise exception 'chalito: bad tz' using errcode = bad;
        end if;
        update chalito.users set tz = v #>> '{}' where id = o;
      when 'call_briefing' then
        if jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'enabled') <> 'boolean' or (v - array['enabled']) <> '{}'::jsonb then
          raise exception 'chalito: call_briefing is {enabled}' using errcode = bad;
        end if;
        update chalito.users set call_briefing = v || jsonb_build_object('ackAt', now()) where id = o;
      when 'quiet_hours' then
        if not chalito_private.valid_quiet_hours(case when jsonb_typeof(v) = 'null' then null else v end) then
          raise exception 'chalito: quiet_hours is null, {"off": true} or {"start": "HH:MM", "end": "HH:MM"}' using errcode = bad;
        end if;
        update chalito.users set quiet_hours = case when jsonb_typeof(v) = 'null' then null else v end where id = o;
      when 'l4_quiet_override' then
        if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
          raise exception 'chalito: l4_quiet_override is a list of sources' using errcode = bad;
        end if;
        update chalito.users set l4_quiet_override = array(select jsonb_array_elements_text(v)) where id = o;
      when 'privacy_mode' then
        update chalito.users set privacy_mode = v #>> '{}' where id = o;
      when 'render_quality' then
        update chalito.users set render_quality = v #>> '{}' where id = o;
      when 'whatsapp_opt_in', 'calls_enabled' then
        if jsonb_typeof(v) <> 'boolean' then raise exception 'chalito: % is a boolean', k using errcode = bad; end if;
        execute format('update chalito.users set %I = $1 where id = $2', k) using (v #>> '{}')::boolean, o;
      when 'sms_enabled' then
        if jsonb_typeof(v) not in ('boolean', 'null') then raise exception 'chalito: sms_enabled is a boolean or null' using errcode = bad; end if;
        update chalito.users set sms_enabled = (v #>> '{}')::boolean where id = o;
      when 'prefs' then
        if jsonb_typeof(v) <> 'object' then raise exception 'chalito: prefs is an object' using errcode = bad; end if;
        update chalito.users set prefs = prefs || v where id = o;
      when 'phone_pending_e164' then
        if jsonb_typeof(v) not in ('string', 'null') then raise exception 'chalito: bad phone' using errcode = bad; end if;
        update chalito.users set phone_pending_e164 = v #>> '{}' where id = o;
      when 'charges_notice_ack_at' then
        -- An acknowledgement, not a client clock: true stamps server time, false withdraws it.
        if jsonb_typeof(v) <> 'boolean' then raise exception 'chalito: charges_notice_ack_at is a boolean ack' using errcode = bad; end if;
        update chalito.users set charges_notice_ack_at = case when (v #>> '{}')::boolean then now() end where id = o;
    end case;
  end loop;
  return chalito_private.my_settings(o);
end
$$;

-- The exposed RPCs: thin invoker wrappers.
create or replace function chalito.get_my_settings()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select chalito_private.get_my_settings() $$;

create or replace function chalito.update_my_settings(p jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select chalito_private.update_my_settings(p) $$;

-- ================================================================ companions
alter table chalito.companions
  add column avatar text check (avatar ~ '^[a-z0-9_-]{1,64}$'),
  add constraint companions_name_length check (char_length(name) between 1 and 40);

-- RFC 4648 base32, lowercase, no padding (the protocol's CompanionId alphabet).
create or replace function chalito_private.base32_lower(b bytea)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  out text := '';
  buf bigint := 0;
  bits int := 0;
  i int;
begin
  for i in 0 .. length(b) - 1 loop
    buf := (buf << 8) | get_byte(b, i);
    bits := bits + 8;
    while bits >= 5 loop
      out := out || substr(alphabet, ((buf >> (bits - 5)) & 31)::int + 1, 1);
      bits := bits - 5;
    end loop;
    buf := buf & ((1::bigint << bits) - 1);
  end loop;
  if bits > 0 then
    out := out || substr(alphabet, ((buf << (5 - bits)) & 31)::int + 1, 1);
  end if;
  return out;
end
$$;

-- Onboarding creates the owner's companion; the id (chl_ + 128 random bits) is minted here.
create or replace function chalito_private.create_my_companion(p_name text, p_avatar text, p_is_renamed boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o text := chalito_private.settings_caller();
  cid text := 'chl_' || chalito_private.base32_lower(extensions.gen_random_bytes(16));
begin
  if o is null then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from chalito.companions where owner = o) then
    raise exception 'chalito: companion_exists' using errcode = '23505';
  end if;
  insert into chalito.companions (owner, companion_id, name, is_renamed, avatar)
  values (o, cid, p_name, coalesce(p_is_renamed, false), p_avatar);
  return jsonb_build_object('companion_id', cid, 'name', p_name, 'is_renamed', coalesce(p_is_renamed, false), 'avatar', p_avatar);
end
$$;

create or replace function chalito.create_my_companion(p_name text, p_avatar text, p_is_renamed boolean default false)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select chalito_private.create_my_companion(p_name, p_avatar, p_is_renamed) $$;

-- ================================================================ connections (status only)
-- BYO keys live in each device's keychain, so connection status is per device. The doc is status
-- only: {mode, connected, updated_at}; never a secret.
create or replace function chalito_private.valid_connection_doc(d jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(d) = 'object'
     and (d - array['mode', 'connected', 'updated_at']) = '{}'::jsonb
     and d ->> 'mode' in ('byo_api_key', 'byo_subscription_local', 'byo_mcp_connector', 'managed')
     and jsonb_typeof(d -> 'connected') = 'boolean'
     and (not d ? 'updated_at' or jsonb_typeof(d -> 'updated_at') in ('number', 'string'))
$$;

alter table chalito.connections drop constraint connections_pkey;
alter table chalito.connections
  add column device_id chalito.id not null,
  add constraint connections_pkey primary key (owner, device_id, provider),
  add constraint connections_device_fkey foreign key (owner, device_id)
    references chalito.devices (owner, device_id) on delete cascade,
  add constraint connections_provider check (provider in ('anthropic', 'openai', 'xai', 'google')),
  add constraint connections_doc_status_only check (chalito_private.valid_connection_doc(doc));

create policy connections_read on chalito.connections for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
create policy connections_agent_insert on chalito.connections for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()));
create policy connections_agent_update on chalito.connections for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id()));
create policy connections_agent_delete on chalito.connections for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()));
create policy server_all on chalito.connections for all to chalito_server using (true) with check (true);

grant select on chalito.connections to authenticated;
grant insert (owner, device_id, provider, doc) on chalito.connections to authenticated;
grant update (doc, updated_at) on chalito.connections to authenticated;
grant delete on chalito.connections to authenticated;
grant select, insert, update, delete on chalito.connections to chalito_server;

-- ================================================================ privileges
revoke all on function chalito_private.valid_quiet_hours(jsonb), chalito_private.settings_caller(), chalito_private.my_settings(text),
  chalito_private.get_my_settings(), chalito_private.update_my_settings(jsonb), chalito_private.base32_lower(bytea),
  chalito_private.create_my_companion(text, text, boolean), chalito_private.valid_connection_doc(jsonb),
  chalito.get_my_settings(), chalito.update_my_settings(jsonb), chalito.create_my_companion(text, text, boolean)
  from public, anon, authenticated, service_role;
-- The invoker wrappers run as the caller, so the caller needs the workers too.
grant execute on function chalito.get_my_settings(), chalito.update_my_settings(jsonb),
  chalito.create_my_companion(text, text, boolean), chalito_private.get_my_settings(),
  chalito_private.update_my_settings(jsonb), chalito_private.create_my_companion(text, text, boolean),
  chalito_private.valid_connection_doc(jsonb) to authenticated;
-- CHECK constraints call these as whoever writes the row.
grant execute on function chalito_private.valid_quiet_hours(jsonb), chalito_private.valid_connection_doc(jsonb)
  to authenticated, chalito_server;
