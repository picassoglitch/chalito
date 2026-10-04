-- Owner-readable audit views (M15). chalito.audit holds what devices record about themselves
-- (agent and device events). Server-side security events (enrolment, revocation, recovery,
-- pairing, phone channels, purchases, MCP grants, rooms) now also land in chalito.server_audit,
-- next to the Pub/Sub → BigQuery stream. The views are security_invoker, so the base tables'
-- RLS applies: an owner sees only their own rows, and only while the membership is good.
-- docs/SECURITY_EVENTS.md is the catalogue of event types.

create table chalito.server_audit (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  eid uuid not null default gen_random_uuid(),
  t timestamptz not null default now(),
  action text not null check (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  -- The principal that acted: a device user id, `hub`, `system`, or a connector id.
  actor text not null check (char_length(actor) <= 128),
  target text check (char_length(target) <= 200),
  meta jsonb not null default '{}' check (octet_length(meta::text) <= 4096),
  cursor bigint generated always as identity,
  primary key (owner, eid)
);
create index server_audit_owner_cursor_idx on chalito.server_audit (owner, cursor);

alter table chalito.server_audit enable row level security;
revoke all on chalito.server_audit from public, anon, authenticated, service_role;
grant select on chalito.server_audit to authenticated;
create policy server_audit_read on chalito.server_audit for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
-- Append-only for the server: no update or delete grant for anyone but the table owner.
grant select, insert on chalito.server_audit to chalito_server;
create policy server_all on chalito.server_audit for all to chalito_server using (true) with check (true);

-- Server time, whatever the caller sent.
create trigger server_audit_server_time before insert on chalito.server_audit
  for each row execute function chalito_private.audit_server_time();

-- Event type → category. One place, so the views and the catalogue agree.
create or replace function chalito.audit_category(type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when type ~ '^(device|pairing|endorse|recovery|webauthn|trust)\.' or type = 'command.rejected' then 'devices'
    when type ~ '^approval\.' then 'approvals'
    when type ~ '^(devmode|policy)\.' or type = 'remote_enable.rejected' then 'devmode'
    when type ~ '^(mcp|oauth|connector)\.' then 'connectors'
    when type ~ '^store\.' then 'store'
    when type ~ '^(phone|channel)\.' then 'channels'
    when type ~ '^room\.' then 'rooms'
    when type ~ '^(sso|tenant)\.' then 'account'
    else 'other'
  end
$$;
-- Only what the views need: not PUBLIC (PostgreSQL's default), anon or chalito_gateway.
revoke all on function chalito.audit_category(text) from public, anon;
grant execute on function chalito.audit_category(text) to authenticated, chalito_server;

create view chalito.audit_trail with (security_invoker = true) as
  select owner, t, type, chalito.audit_category(type) as category, 'device' as origin,
         device_id::text as actor, null::text as target, meta
    from chalito.audit
  union all
  select owner, t, action, chalito.audit_category(action), 'server', actor, target, meta
    from chalito.server_audit;

create view chalito.audit_devices with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'devices';
create view chalito.audit_devmode with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'devmode';
create view chalito.audit_connectors with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'connectors';
create view chalito.audit_store with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'store';

-- Approvals: every resolved request (who decided, how, on which device), plus approval events.
-- details_ct (sealed) and the decision signature stay out of the view.
create view chalito.audit_approvals with (security_invoker = true) as
  select a.owner, coalesce(a.resolved_at, a.expires_at) as t, 'approval.' || a.status as type,
         'approvals' as category, 'server' as origin, a.device_id::text as actor, a.aid::text as target,
         jsonb_build_object('sid', a.sid, 'kind', a.kind, 'risk', a.risk, 'origin', a.origin,
                            'step_up_required', a.step_up_required, 'reason', a.reason,
                            'signer_device_id', d.signer_device_id) as meta
    from chalito.approvals a
    left join lateral (
      select signer_device_id from chalito.approval_decisions
       where owner = a.owner and aid = a.aid order by created_at desc limit 1
    ) d on true
   where a.status <> 'pending'
  union all
  select * from chalito.audit_trail where category = 'approvals';

grant select on chalito.audit_trail, chalito.audit_devices, chalito.audit_approvals, chalito.audit_devmode,
  chalito.audit_connectors, chalito.audit_store to authenticated;
revoke all on chalito.audit_trail, chalito.audit_devices, chalito.audit_approvals, chalito.audit_devmode,
  chalito.audit_connectors, chalito.audit_store from anon;
