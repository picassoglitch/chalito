-- M10: the MCP gateway's database access and card sharing (ADR 0009, D-035).
--
-- chalito_gateway is READ-ONLY: it reads token hashes and grants (to authorize each call), pending
-- approvals and session rows (metadata), devices (box keys to seal to, labels), the sharing switches
-- and the opted-in plaintext cards. Every gateway write (post_to_mesa, recommend_decision,
-- prompt_session) goes through the api, which re-checks the grant's scopes. It holds no signing key
-- and can write nothing: not decisions, devices, endorsements, policy, rooms or billing (tested).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chalito_gateway') then
    create role chalito_gateway nologin nobypassrls;
  end if;
end
$$;
grant chalito_gateway to postgres with inherit false, set true;
grant usage on schema chalito, chalito_private to chalito_gateway;

-- ---------------------------------------------------------------- card sharing (opt-in)
-- Per session or per device, default off. While on, the agent may keep a plaintext copy of the
-- session card for MCP; turning it off deletes that copy (trigger below).
create table chalito.mcp_sharing (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  scope text not null check (scope in ('session', 'device')),
  target chalito.id not null,
  enabled boolean not null default false,
  -- The user acknowledged the plaintext warning (server time) when turning it on.
  plaintext_ack_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner, scope, target),
  check (not enabled or plaintext_ack_at is not null)
);

create table chalito.session_card_plain (
  owner chalito.id not null,
  sid chalito.id not null,
  device_id chalito.id not null,
  card jsonb not null check (jsonb_typeof(card) = 'object' and octet_length(card::text) <= 16384),
  updated_at timestamptz not null default now(),
  primary key (owner, sid),
  foreign key (owner, sid) references chalito.sessions (owner, sid) on delete cascade
);

create or replace function chalito_private.mcp_sharing_on(p_owner text, p_sid text, p_device text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from chalito.mcp_sharing s where s.owner = p_owner and s.enabled
                 and ((s.scope = 'session' and s.target = p_sid) or (s.scope = 'device' and s.target = p_device)))
$$;

-- Turning sharing off deletes the plaintext copies it covered.
create or replace function chalito_private.mcp_sharing_off()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.enabled then
    delete from chalito.session_card_plain p
    where p.owner = new.owner
      and ((new.scope = 'session' and p.sid = new.target) or (new.scope = 'device' and p.device_id = new.target))
      and not chalito_private.mcp_sharing_on(p.owner, p.sid, p.device_id);
  end if;
  return null;
end
$$;
create trigger mcp_sharing_off after insert or update on chalito.mcp_sharing
  for each row execute function chalito_private.mcp_sharing_off();

alter table chalito.mcp_sharing enable row level security;
alter table chalito.session_card_plain enable row level security;

create policy mcp_sharing_read on chalito.mcp_sharing for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
-- The agent writes its own session's plaintext card, and only while sharing is on for it.
create policy session_card_plain_agent_write on chalito.session_card_plain for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent())
              and chalito_private.mcp_sharing_on(owner, sid, device_id));
create policy session_card_plain_agent_update on chalito.session_card_plain for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (chalito_private.mcp_sharing_on(owner, sid, device_id));
create policy session_card_plain_read on chalito.session_card_plain for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

create policy server_all on chalito.mcp_sharing for all to chalito_server using (true) with check (true);
create policy server_all on chalito.session_card_plain for all to chalito_server using (true) with check (true);

revoke all on chalito.mcp_sharing, chalito.session_card_plain from public, anon, authenticated, service_role;
grant select on chalito.mcp_sharing, chalito.session_card_plain to authenticated;
grant insert (owner, sid, device_id, card), update (card, updated_at) on chalito.session_card_plain to authenticated;
grant select, insert, update, delete on chalito.mcp_sharing, chalito.session_card_plain to chalito_server;
revoke all on function chalito_private.mcp_sharing_on(text, text, text), chalito_private.mcp_sharing_off()
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.mcp_sharing_on(text, text, text) to authenticated, chalito_server, chalito_gateway;

-- ---------------------------------------------------------------- post_to_mesa (M9 stub)
-- The api stores MCP turns into the owner's Mesa inbox; the rest of Mesa arrives in M9.
grant select, insert on chalito.mesas, chalito.mesa_turns to chalito_server;
create policy server_all on chalito.mesas for all to chalito_server using (true) with check (true);
create policy server_all on chalito.mesa_turns for all to chalito_server using (true) with check (true);

-- ---------------------------------------------------------------- the gateway's reads
do $$
declare
  t text;
begin
  foreach t in array array['chalito_private.oauth_tokens', 'chalito.connectors', 'chalito.approvals', 'chalito.sessions',
                           'chalito.devices', 'chalito.mcp_sharing', 'chalito.session_card_plain'] loop
    execute format('grant select on %s to chalito_gateway', t);
    execute format('create policy gateway_read on %s for select to chalito_gateway using (true)', t);
  end loop;
end
$$;
