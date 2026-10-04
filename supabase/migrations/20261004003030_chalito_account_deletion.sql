-- Account deletion for ARCO requests (LFPDPPP "cancelación") and GDPR erasure (M15). The owner asks
-- from a trusted client with a passkey step-up; the api builds an export first, then the deletion
-- waits 7 days, during which the owner can cancel. When due, the api deletes the device Auth users
-- and the owner's storage prefixes, then calls chalito_private.delete_account. Only Chalito's data
-- is deleted: the hub account, its balance and payments are the hub's (ADR 0016).

create table chalito_private.account_deletions (
  owner chalito.id primary key references chalito.users (id) on delete cascade,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  requested_at timestamptz not null default now(),
  requested_by chalito.id not null,
  due_at timestamptz not null,
  cancelled_at timestamptz,
  -- Where the export written at request time lives (bucket object path).
  export_path text not null
);
create index account_deletions_due on chalito_private.account_deletions (due_at) where status = 'scheduled';

alter table chalito_private.account_deletions enable row level security;
revoke all on chalito_private.account_deletions from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.account_deletions to chalito_server;
create policy server_all on chalito_private.account_deletions for all to chalito_server using (true) with check (true);

-- Everything Chalito holds about an owner, as JSON: every table in schema chalito keyed by the
-- owner (owner / uid / owner_uid, or users.id and its tenant), plus the owner's usage and voice
-- metering. Secrets never leave: recovery hashes, OAuth token hashes and wrapped BYO keys are
-- chalito_private and not included.
create or replace function chalito_private.export_account(p_owner text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t record;
  rows jsonb;
  out jsonb := jsonb_build_object('owner', p_owner, 'exported_at', now(), 'tables', '{}'::jsonb);
begin
  for t in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'chalito' and tb.table_type = 'BASE TABLE'
      and c.column_name in ('owner', 'uid', 'owner_uid')
    order by c.table_name, c.column_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from chalito.%I x where %I = $1',
                   t.table_name, t.column_name)
      into rows using p_owner;
    out := jsonb_set(out, array['tables', t.table_name || case when t.column_name = 'owner' then '' else '.' || t.column_name end], rows);
  end loop;
  out := jsonb_set(out, '{tables,users}',
    (select coalesce(jsonb_agg(to_jsonb(u)), '[]') from chalito.users u where u.id = p_owner));
  out := jsonb_set(out, '{tables,tenants}',
    (select coalesce(jsonb_agg(to_jsonb(tn)), '[]') from chalito.tenants tn
      where tn.id = (select tenant_id from chalito.users where id = p_owner)));
  out := jsonb_set(out, '{tables,usage}',
    (select coalesce(jsonb_agg(o.event order by o.created_at), '[]') from chalito_private.usage_outbox o where o.owner = p_owner));
  out := jsonb_set(out, '{tables,voice_sessions}',
    (select coalesce(jsonb_agg(to_jsonb(v) - 'reservation_id'), '[]') from chalito_private.voice_sessions v where v.owner = p_owner));
  return out;
end
$$;

-- Deletes the owner's Chalito data. Nearly everything cascades from chalito.users; the rest is
-- deleted here. Usage not yet reported to the hub stays until the drainer sends it (it carries
-- only the hub's user id and amounts), so the hub still bills what was used.
create or replace function chalito_private.delete_account(p_owner text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := (select tenant_id from chalito.users where id = p_owner);
  n_devices integer := (select count(*) from chalito.devices where owner = p_owner);
begin
  delete from chalito_private.usage_outbox where owner = p_owner and status <> 'pending';
  delete from chalito_private.credit_balance where owner = p_owner;
  delete from chalito_private.credit_ledger where owner = p_owner;
  delete from chalito_private.event_gates where owner = p_owner;
  delete from chalito_private.purchases where owner = p_owner;
  delete from chalito_private.subscriptions where owner = p_owner;
  delete from chalito.users where id = p_owner;
  -- The tenant mirror goes too when no other user is in it.
  delete from chalito.tenants tn
    where tn.id = v_tenant and not exists (select 1 from chalito.users u where u.tenant_id = v_tenant);
  return jsonb_build_object('owner', p_owner, 'devices', n_devices, 'deleted_at', now());
end
$$;

revoke all on function chalito_private.export_account(text), chalito_private.delete_account(text)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.export_account(text), chalito_private.delete_account(text) to chalito_server;

-- account.* events in the owner-readable audit (category 'account').
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
    when type ~ '^(sso|tenant|account)\.' then 'account'
    else 'other'
  end
$$;
revoke all on function chalito.audit_category(text) from public, anon;
grant execute on function chalito.audit_category(text) to authenticated, chalito_server;
