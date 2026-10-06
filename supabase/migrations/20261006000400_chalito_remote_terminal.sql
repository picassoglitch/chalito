-- Remote terminal (apps/agent/src/terminal). Turned on only on the device (OS auth +
-- confirmations; the raw shell is a separate, stronger toggle); each terminal asks for a
-- `terminal` approval, always HIGH with a passkey step-up. Terminal bytes travel sealed in
-- session_events (`terminal.output`); the agent audits `terminal.*` with metadata only (ids,
-- sizes, counts, reasons; never the bytes). docs/SECURITY_EVENTS.md lists the event types.

-- The new approval kind. HIGH/CRITICAL already require step_up_required (approvals table check).
alter table chalito.approvals drop constraint approvals_kind_check;
alter table chalito.approvals add constraint approvals_kind_check
  check (kind in ('tool', 'decision', 'computer_control', 'terminal'));

-- terminal.* events get their own category, next to computer.
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
    when type ~ '^computer\.' then 'computer'
    when type ~ '^terminal\.' then 'terminal'
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

create view chalito.audit_terminal with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'terminal';
grant select on chalito.audit_terminal to authenticated;
revoke all on chalito.audit_terminal from anon;
