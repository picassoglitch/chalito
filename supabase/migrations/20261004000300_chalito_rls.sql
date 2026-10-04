-- Row-level security: a port of firestore.rules (origin/m3-agent). Deny by default: a table with
-- RLS on and no matching policy returns no rows and rejects writes.
--
-- Helpers are wrapped as `(select f())` in policies so the planner evaluates them once per
-- statement (an initPlan), not once per row (Supabase RLS performance guide).

-- The caller's device exists, belongs to the token's owner, has the token's role and is not
-- revoked. Read on every statement, so a revoked device is denied on its very next read or write.
create or replace function chalito_private.device_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from chalito.devices d
    where d.device_id = chalito.jwt_device_id()
      and d.owner = chalito.jwt_owner()
      and d.role = chalito.jwt_role()
      and not d.revoked
  )
$$;

-- firestore.rules member(uid) for the token's own owner: a user session, or any active device.
create or replace function chalito_private.member_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select chalito.jwt_owner() is not null
     and (chalito.jwt_role() = 'user' or chalito_private.device_ok())
$$;

create or replace function chalito_private.active_client()
returns boolean language sql stable security definer set search_path = ''
as $$ select chalito.jwt_role() = 'client' and chalito_private.device_ok() $$;

create or replace function chalito_private.active_agent()
returns boolean language sql stable security definer set search_path = ''
as $$ select chalito.jwt_role() = 'agent' and chalito_private.device_ok() $$;

revoke execute on function chalito_private.device_ok(), chalito_private.member_ok(),
  chalito_private.active_client(), chalito_private.active_agent() from public;
grant execute on function chalito_private.device_ok(), chalito_private.member_ok(),
  chalito_private.active_client(), chalito_private.active_agent() to authenticated, service_role;

-- Raises unless NEW differs from OLD only in `allowed` columns (firestore.rules `onlyChanges`).
create or replace function chalito_private.assert_only_changes(old_row jsonb, new_row jsonb, allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  for k in select key from jsonb_object_keys(old_row || new_row) as key loop
    if not (k = any (allowed)) and (old_row -> k) is distinct from (new_row -> k) then
      raise exception 'chalito: column % may not be changed here', k using errcode = '42501';
    end if;
  end loop;
end
$$;
revoke execute on function chalito_private.assert_only_changes(jsonb, jsonb, text[]) from public;
-- Called from guard triggers, which run as the invoking role.
grant execute on function chalito_private.assert_only_changes(jsonb, jsonb, text[]) to authenticated, service_role;

-- ================================================================ users / tenants
-- users/{uid}: read by members; write server only. tenants: server only.
create policy users_read on chalito.users for select to authenticated
  using (id = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- ================================================================ devices
create policy devices_read on chalito.devices for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- devMode and policyHash (and presence fields) are written only by the device itself. The
-- column grant limits the columns; create, delete and every other column are server only.
create policy devices_self_update on chalito.devices for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and not revoked);

create policy endorsements_read on chalito.endorsements for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- ================================================================ pairing codes
-- The agent waits on its own pairing code with a token scoped to that code only.
create policy pairing_codes_watch on chalito.pairing_codes for select to authenticated
  using ((select chalito.jwt_role()) = 'pairing'
         and code_id = (select chalito.jwt_pairing_code())
         and expires_at > now());

-- ================================================================ commands
-- An active client of the same owner writes signed command envelopes to one of the owner's
-- active agents. Relays (`relayedBy`) come from the gateway/notifier as service_role only.
create policy commands_client_create on chalito.commands for insert to authenticated
  with check (
    owner = (select chalito.jwt_owner())
    and (select chalito_private.active_client())
    and from_device_id = (select chalito.jwt_device_id())
    and jsonb_typeof(env) = 'object'
    and not (env ? 'relayedBy')
    and env ->> 'ctx' = 'chalito.command.v1'
    and expires_at > now()
    and exists (select 1 from chalito.devices d
                where d.owner = commands.owner and d.device_id = commands.target_device_id
                  and d.role = 'agent' and not d.revoked)
  );

-- Only the target agent reads and deletes (acknowledges) its commands.
create policy commands_agent_read on chalito.commands for select to authenticated
  using (owner = (select chalito.jwt_owner()) and target_device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()) and expires_at > now());

create policy commands_agent_delete on chalito.commands for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and target_device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()));

-- ================================================================ sessions / events
create policy sessions_read on chalito.sessions for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

create policy sessions_agent_create on chalito.sessions for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()));

-- Stricter than Firestore (which only checked the new deviceId): an agent can't take over a
-- session row another device wrote.
create policy sessions_agent_update on chalito.sessions for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id()));

create policy session_events_read on chalito.session_events for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok())
         and expires_at > now());

create policy session_events_agent_create on chalito.session_events for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()));

-- ================================================================ approvals
create policy approvals_read on chalito.approvals for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

create policy approvals_agent_create on chalito.approvals for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()) and status = 'pending');

-- Clients attach a signed decision while pending; the owning agent resolves. Which columns each
-- may change is enforced by approvals_guard below (RLS can't compare OLD and NEW).
create policy approvals_update on chalito.approvals for update to authenticated
  using (owner = (select chalito.jwt_owner())
         and (((select chalito_private.active_client()) and status = 'pending')
              or ((select chalito_private.active_agent()) and device_id = (select chalito.jwt_device_id()))))
  with check (owner = (select chalito.jwt_owner()));

create or replace function chalito_private.approvals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if chalito.jwt_role() = 'client' then
    if old.status <> 'pending' then
      raise exception 'chalito: approval is no longer pending' using errcode = '42501';
    end if;
    perform chalito_private.assert_only_changes(to_jsonb(old), to_jsonb(new), array['decision']);
  elsif chalito.jwt_role() = 'agent' then
    perform chalito_private.assert_only_changes(to_jsonb(old), to_jsonb(new), array['status', 'reason', 'resolved_at']);
  else
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke execute on function chalito_private.approvals_guard() from public;
create trigger approvals_guard before update on chalito.approvals
  for each row execute function chalito_private.approvals_guard();

-- ================================================================ notifications
create policy notifications_read on chalito.notifications for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- Clients acknowledge (column grant: state, acked_at, acked_via); create/delete server only.
create policy notifications_client_ack on chalito.notifications for update to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.active_client()))
  with check (owner = (select chalito.jwt_owner()));

-- ================================================================ call lines
create policy call_lines_agent_create on chalito.call_lines for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()));

-- Postgres applies SELECT policies to the rows a DELETE's WHERE reads, so the agent can see the
-- keys (column grant) of its own lines. The line text stays notifier-only.
create policy call_lines_agent_keys on chalito.call_lines for select to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()));

create policy call_lines_agent_delete on chalito.call_lines for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()));

-- ================================================================ audit
create policy audit_read on chalito.audit for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- Create-only, by the active agent about itself. No update/delete grant exists for anyone but
-- service_role.
create policy audit_agent_create on chalito.audit for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()));

-- Server time, whatever the client sent.
create or replace function chalito_private.audit_server_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.t := now();
  return new;
end
$$;
revoke execute on function chalito_private.audit_server_time() from public;
create trigger audit_server_time before insert on chalito.audit
  for each row execute function chalito_private.audit_server_time();

-- ================================================================ companions / inventory
create policy companions_read on chalito.companions for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- Rename/persona/voice only (column grant); `equipped` is server-validated against inventory.
create policy companions_client_update on chalito.companions for update to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.active_client()))
  with check (owner = (select chalito.jwt_owner()));

create policy inventory_read on chalito.inventory for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

-- ================================================================ housekeeping triggers
create or replace function chalito_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
revoke execute on function chalito_private.touch_updated_at() from public;
create trigger sessions_touch before update on chalito.sessions
  for each row execute function chalito_private.touch_updated_at();

-- tenants, endorsements writes, private_recovery, sso_tokens, device_nonces: no policies, so
-- clients get nothing; service_role bypasses RLS.
