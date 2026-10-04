-- Beta security review (docs/reviews/beta-security-review.md): database fixes.
--   R-H4: a forged app_metadata role "user" got member access to any owner.
--   R-M7: the Chalito Realtime guard called an authenticated-only function for anon too.
--   R-L8: agents could seed recommendations or reopen resolved approvals; clients could re-arm
--         notifications with any acked_at; nothing reserved the device id "orchestrator".

-- ================================================================ R-H4
-- In app_metadata mode only device and pairing roles come from app_metadata.chalito. "user" comes
-- only from the hub-session branch, where the owner IS the sub.
create or replace function chalito.jwt_claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when not (coalesce(j -> 'aud', 'null') = '"authenticated"'
              or (jsonb_typeof(j -> 'aud') = 'array' and j -> 'aud' ? 'authenticated')) then null
    when chalito_private.claim_source() = 'app_metadata' then
      case
        when jsonb_typeof(j -> 'app_metadata' -> 'chalito') = 'object' then
          case when j -> 'app_metadata' -> 'chalito' ->> 'role' in ('client', 'agent', 'pairing') then jsonb_build_object(
            'sub', j ->> 'sub',
            'owner', j -> 'app_metadata' -> 'chalito' ->> 'owner',
            'device_id', j -> 'app_metadata' -> 'chalito' ->> 'device_id',
            'chalito_role', j -> 'app_metadata' -> 'chalito' ->> 'role',
            'pairing_code', j -> 'app_metadata' -> 'chalito' ->> 'pairing_code')
          end
        when nullif(j ->> 'sub', '') is not null and coalesce(j ->> 'is_anonymous', 'false') <> 'true'
             and not (j -> 'app_metadata' ? 'chalito') then
          jsonb_build_object('sub', j ->> 'sub', 'owner', j ->> 'sub', 'chalito_role', 'user')
      end
    when chalito_private.claim_source() = 'custom' and j ->> 'iss' = chalito_private.claim_issuer() then
      case
        when j ->> 'chalito_role' in ('client', 'agent') and j ->> 'sub' = 'd_' || (j ->> 'device_id') then j
        when j ->> 'chalito_role' = 'user' and j ->> 'sub' = 'u_' || (j ->> 'owner') then j
        when j ->> 'chalito_role' = 'pairing' and j ->> 'sub' = 'p_' || (j ->> 'pairing_code') then j
      end
  end
  from (select auth.jwt() as j) as s
$$;

-- Defence in depth: a "user" principal must be bound to its sub.
create or replace function chalito_private.member_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select chalito.jwt_owner() is not null
     and ((chalito.jwt_role() = 'user'
           and ((chalito.jwt_claims() ->> 'sub') = chalito.jwt_owner()
                or (chalito.jwt_claims() ->> 'sub') = 'u_' || chalito.jwt_owner()))
          or chalito_private.device_ok())
$$;

-- ================================================================ R-M7
-- The guard only needs the function for authenticated callers. anon gets a function-free guard
-- that simply keeps it off chalito:* topics, so hub anon channels keep working.
drop policy chalito_topics_guard on realtime.messages;
create policy chalito_topics_guard on realtime.messages as restrictive for all to authenticated
  using (
    not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%')
    or (realtime.messages.topic = (select realtime.topic())
        and (select chalito_private.realtime_topic_ok(realtime.topic())))
  )
  with check (
    not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%')
  );
create policy chalito_topics_guard_anon on realtime.messages as restrictive for all to anon
  using (not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%'))
  with check (not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%'));

-- ================================================================ R-L8
-- Agents create approvals without recommendations (only the server appends advisory ones).
drop policy approvals_agent_create on chalito.approvals;
create policy approvals_agent_create on chalito.approvals for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()) and status = 'pending'
              and recommendations = '[]'::jsonb
              and exists (select 1 from chalito.sessions s where s.owner = approvals.owner
                            and s.sid = approvals.sid and s.device_id = (select chalito.jwt_device_id())));

-- Agents resolve their own pending approvals once; a resolved approval never goes back.
create or replace function chalito_private.approvals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if chalito.jwt_role() = 'agent' then
    perform chalito_private.assert_only_changes(to_jsonb(old), to_jsonb(new), array['status', 'reason', 'resolved_at', 'rev']);
    if old.status <> 'pending' and new.status is distinct from old.status then
      raise exception 'chalito: a resolved approval stays resolved' using errcode = '42501';
    end if;
  else
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  return new;
end
$$;

-- Client acks are stamped with server time and can't be re-armed.
create or replace function chalito_private.notifications_ack_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if old.state = 'acked' then
    if new.state is distinct from 'acked' then
      raise exception 'chalito: an acknowledged notification stays acknowledged' using errcode = '42501';
    end if;
    -- A repeat ack (another device, a retry) is a no-op: the first one stands.
    new.acked_at := old.acked_at;
    new.acked_via := old.acked_via;
    return new;
  end if;
  if new.state = 'acked' then
    new.acked_at := now();
  elsif new.acked_at is distinct from old.acked_at then
    raise exception 'chalito: acked_at is set by the server' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke execute on function chalito_private.notifications_ack_guard() from public;
create trigger notifications_ack_guard before update on chalito.notifications
  for each row execute function chalito_private.notifications_ack_guard();

-- The orchestrator's pseudo-device id can never be a real device.
alter table chalito.devices add constraint devices_reserved_ids check (device_id::text <> 'orchestrator');
