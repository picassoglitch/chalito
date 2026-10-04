-- M9: Mesa. The orchestrator (as chalito_server) creates Mesas and writes every turn, sealed to the
-- owner's client devices; clients read them under RLS and get Realtime pointers. Plaintext exists
-- only in the orchestrator's memory on the way to the provider (D-007). mesas.doc holds metadata
-- only: participants, budgets and token counters (no goal, no card, no text).

alter table chalito.mesas add column cursor bigint generated always as identity;
alter table chalito.mesa_turns add column cursor bigint generated always as identity;
create index mesas_owner_cursor_idx on chalito.mesas (owner, cursor);
create index mesa_turns_owner_cursor_idx on chalito.mesa_turns (owner, cursor);

-- ---------------------------------------------------------------- reads: the owner's devices
create policy mesas_read on chalito.mesas for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
create policy mesa_turns_read on chalito.mesa_turns for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
grant select on chalito.mesas, chalito.mesa_turns to authenticated;

-- ---------------------------------------------------------------- writes: the orchestrator only
-- (insert on both and the server_all policies came with 001800 for the gateway's MCP inbox.)
grant update (doc) on chalito.mesas to chalito_server;

-- ---------------------------------------------------------------- realtime pointers to clients
create or replace function chalito_private.broadcast_mesa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := to_jsonb(new); -- mesas has no tid: read fields from JSON, not the record
begin
  perform chalito_private.send_to_devices(
    r ->> 'owner',
    tg_table_name,
    jsonb_build_object(
      'table', tg_table_name,
      'op', lower(tg_op),
      'key', case when tg_table_name = 'mesa_turns'
                  then jsonb_build_object('mid', r -> 'mid', 'tid', r -> 'tid')
                  else jsonb_build_object('mid', r -> 'mid') end,
      'cursor', r -> 'cursor'),
    null,
    'client');
  return null;
end
$$;
revoke execute on function chalito_private.broadcast_mesa() from public;

create trigger mesas_broadcast after insert or update on chalito.mesas
  for each row execute function chalito_private.broadcast_mesa();
create trigger mesa_turns_broadcast after insert on chalito.mesa_turns
  for each row execute function chalito_private.broadcast_mesa();
