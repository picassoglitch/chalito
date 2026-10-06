-- Remote screen and app control (engine contract 2026-10-06; apps/agent/src/screen,
-- apps/agent/src/computer). Turned on only on the device (OS auth + confirmations); every
-- session asks its own approval, always HIGH with a passkey step-up:
--   remote_view     a trusted browser watches the screen (WebRTC, frames never reach the cloud)
--   remote_control  … and sends mouse / keyboard input
--   app_control     an AI session launches and drives one app or AI website
--   terminal        a remote terminal session (remote-terminal builder; listed here too so the
--                   kinds stay one list whichever migration lands last)
-- The agent audits screen.* with metadata only (counts and reasons; no pixels, keys or text).

alter table chalito.approvals drop constraint approvals_kind_check;
alter table chalito.approvals add constraint approvals_kind_check
  check (kind in ('tool', 'decision', 'computer_control', 'terminal', 'remote_view', 'remote_control', 'app_control'));

-- screen.* joins computer.* in the computer category (one place for "who used this screen").
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
    when type ~ '^(computer|screen)\.' then 'computer'
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
