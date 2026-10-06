-- Computer control (apps/agent/src/computer). Turned on only on the device (OS auth +
-- confirmations); each session that uses it asks for a `computer_control` approval, always HIGH
-- with a passkey step-up. Every action is audited by the agent as `computer.*` (metadata only:
-- no screen contents, no typed text). docs/SECURITY_EVENTS.md lists the event types.

-- The new approval kind. HIGH/CRITICAL already require step_up_required (approvals table check).
alter table chalito.approvals drop constraint approvals_kind_check;
alter table chalito.approvals add constraint approvals_kind_check
  check (kind in ('tool', 'decision', 'computer_control'));

-- computer.* events get their own category, next to devmode.
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

create view chalito.audit_computer with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'computer';
grant select on chalito.audit_computer to authenticated;
revoke all on chalito.audit_computer from anon;
