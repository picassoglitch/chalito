-- Beta security review (docs/reviews/beta-security-review.md), MCP data items:
--   R-L3  an agent could write the plaintext MCP card for another agent's session;
--   R-L5  mcp_sharing_on(p_owner, …) let any signed-in user probe another account's sharing;
--   R-L7  the gateway could read every column of sessions (doc), approvals (details_ct) and devices.

-- ---------------------------------------------------------------- R-L5: no cross-account oracle
-- The caller's own account only; what RLS policies use.
create or replace function chalito_private.mcp_sharing_on_mine(p_sid text, p_device text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select chalito_private.mcp_sharing_on(chalito.jwt_owner(), p_sid, p_device)
$$;
revoke all on function chalito_private.mcp_sharing_on_mine(text, text) from public, anon, authenticated, service_role;
grant execute on function chalito_private.mcp_sharing_on_mine(text, text) to authenticated;
-- The three-argument form stays for the server, the gateway and the sharing trigger only.
revoke execute on function chalito_private.mcp_sharing_on(text, text, text) from authenticated;

-- ---------------------------------------------------------------- R-L3: only the session's own agent
drop policy session_card_plain_agent_write on chalito.session_card_plain;
drop policy session_card_plain_agent_update on chalito.session_card_plain;
create policy session_card_plain_agent_write on chalito.session_card_plain for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent())
              and exists (select 1 from chalito.sessions s
                          where s.owner = session_card_plain.owner and s.sid = session_card_plain.sid
                            and s.device_id = (select chalito.jwt_device_id()))
              and chalito_private.mcp_sharing_on_mine(sid, device_id));
create policy session_card_plain_agent_update on chalito.session_card_plain for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (exists (select 1 from chalito.sessions s
                      where s.owner = session_card_plain.owner and s.sid = session_card_plain.sid
                        and s.device_id = (select chalito.jwt_device_id()))
              and chalito_private.mcp_sharing_on_mine(sid, device_id));

-- ---------------------------------------------------------------- R-L7: the gateway reads only what it shows
-- sessions: through a narrow view (adapter and state out of doc; never the rest of doc).
create view chalito_private.gateway_sessions as
  select owner, sid, device_id, doc ->> 'adapter' as adapter, doc ->> 'state' as state, updated_at
  from chalito.sessions;
revoke all on chalito_private.gateway_sessions from public, anon, authenticated, service_role;
grant select on chalito_private.gateway_sessions to chalito_gateway;
revoke select on chalito.sessions from chalito_gateway;
drop policy gateway_read on chalito.sessions;

-- approvals: metadata only, never the sealed details.
revoke select on chalito.approvals from chalito_gateway;
grant select (owner, aid, sid, device_id, kind, risk, origin, step_up_required, status, created_at, expires_at,
              recommendations)
  on chalito.approvals to chalito_gateway;

-- devices: identity, label and box key (to seal Mesa posts and prompts), nothing else.
revoke select on chalito.devices from chalito_gateway;
grant select (owner, device_id, role, name, pub_box, revoked) on chalito.devices to chalito_gateway;
