-- Agent-to-agent links (ADR 0022 §3), part 1: the command path, the approval kind and the audit
-- category. The links themselves live on each device (apps/agent/src/links, a signed local
-- file); nothing here grants a link.
--
-- 1. approvals: `link_handoff`, the one phone tap before a hand-off is delivered ("ask me each
--    time", the default). MED without step-up; every earlier kind is kept (this is now the
--    migration that redefines the list).
-- 2. commands: an active agent may relay a signed agent-link envelope to another active agent of
--    the same owner. Only the three link payloads, only from an `agent:*` origin, only signed in
--    the sender's own name; the receiving agent checks the signature against the key it recorded
--    locally for the link, so RLS only gates who may write. Clients keep commands_client_create,
--    which still refuses any `relayedBy`.
-- 3. audit: link.* gets its own category and view (every earlier category kept).

alter table chalito.approvals drop constraint approvals_kind_check;
alter table chalito.approvals add constraint approvals_kind_check
  check (kind in ('tool', 'decision', 'computer_control', 'terminal', 'remote_view', 'remote_control', 'app_control',
                  'link_handoff'));

create policy commands_agent_link_create on chalito.commands for insert to authenticated
  with check (
    owner = (select chalito.jwt_owner())
    and (select chalito_private.active_agent())
    and from_device_id = (select chalito.jwt_device_id())
    and jsonb_typeof(env) = 'object'
    and env ->> 'relayedBy' = 'agent-link'
    and not (env ? 'ctx')
    and env ->> 'signerDeviceId' = (select chalito.jwt_device_id())
    and jsonb_typeof(env -> 'body') = 'object'
    and env -> 'body' ->> 'origin' ~ '^agent:[A-Za-z0-9_-]{1,128}$'
    and env -> 'body' -> 'payload' ->> 'type' in ('link.handoff', 'link.share', 'link.result')
    and env -> 'body' ->> 'targetDeviceId' = target_device_id
    and env -> 'body' ->> 'uid' = owner
    and expires_at > now()
    and exists (select 1 from chalito.devices d
                where d.owner = commands.owner and d.device_id = commands.target_device_id
                  and d.role = 'agent' and not d.revoked)
  );

-- Every category so far, plus links.
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
    when type ~ '^screen\.' then 'screen'
    when type ~ '^link\.' then 'links'
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

create view chalito.audit_links with (security_invoker = true) as
  select * from chalito.audit_trail where category = 'links';
grant select on chalito.audit_links to authenticated;
revoke all on chalito.audit_links from anon;
