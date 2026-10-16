-- M16 D, connect everything (ADR 0022 §4; D-071).
--
-- 1. A new scope, `link:handoff`: create a hand-off task on one of the owner's agents, through the
--    MCP gateway's `create_task` or the A2A server's `SendMessage`. Off by default (never
--    pre-checked), and every task still goes through a LinkAuthorizer before the api relays it.
-- 2. App status docs accept the two new recipe kinds, `chat-api` and `a2a`.
-- 3. chalito.a2a_exposures: the agents the owner exposes on Chalito's A2A server (none by default).
--    Written by the api (chalito_server); the person reads their own; the gateway (read-only) reads
--    them to serve cards. The A2A server itself is off unless configured (CHALITO_A2A_ENABLED).
-- 4. The gateway may read app status rows (`list_agents`: app id, device, state and kind only).
--
-- This migration doesn't touch chalito.audit_category (Phase C's 20261015000200 redefines it).

-- ---------------------------------------------------------------- 1. the scopes
create or replace function chalito_private.mcp_scopes()
returns text[] language sql immutable set search_path = ''
as $$ select array['mcp:read', 'mesa:post', 'approval:recommend', 'session:prompt', 'link:handoff'] $$;

-- ---------------------------------------------------------------- 2. app status docs
create or replace function chalito_private.valid_connection_doc(d jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(d) = 'object' and (
    -- Before 2026-10-06 (settings migration 001100).
    ((d - array['mode', 'connected', 'updated_at']) = '{}'::jsonb
     and d ->> 'mode' in ('byo_api_key', 'byo_subscription_local', 'byo_mcp_connector', 'managed')
     and jsonb_typeof(d -> 'connected') = 'boolean'
     and (not d ? 'updated_at' or jsonb_typeof(d -> 'updated_at') in ('number', 'string')))
    or
    -- ProviderConnectionDoc (migration 20261006000100) and AppConnectionDoc (this one): the same
    -- core, plus kind/custom/name for apps.
    ((d - array['mode', 'connected', 'state', 'cli', 'error', 'at', 'kind', 'custom', 'name']) = '{}'::jsonb
     and d ?& array['mode', 'connected', 'state', 'cli', 'error', 'at']
     and (jsonb_typeof(d -> 'mode') = 'null' or d ->> 'mode' in ('api_key', 'signin'))
     and jsonb_typeof(d -> 'connected') = 'boolean'
     and d ->> 'state' in ('not_installed', 'installing', 'needs_auth', 'signing_in', 'connected', 'error',
                           'blocked_by_policy', 'available')
     and (d -> 'connected') = to_jsonb(d ->> 'state' = 'connected')
     and jsonb_typeof(d -> 'cli') = 'object'
     and ((d -> 'cli') - array['installed', 'version']) = '{}'::jsonb
     and jsonb_typeof(d -> 'cli' -> 'installed') = 'boolean'
     and (jsonb_typeof(d -> 'cli' -> 'version') = 'null'
          or (jsonb_typeof(d -> 'cli' -> 'version') = 'string' and length(d -> 'cli' ->> 'version') <= 64))
     and (jsonb_typeof(d -> 'error') = 'null'
          or d ->> 'error' in ('install_failed', 'install_unconfirmed', 'npm_missing', 'pin_failed', 'signin_failed',
                               'signin_timeout', 'key_invalid', 'keychain_failed', 'status_failed',
                               'launch_failed', 'unsupported_platform', 'install_unavailable', 'recipe_disabled'))
     and jsonb_typeof(d -> 'at') = 'number'
     -- kind and custom come together (an app doc) or not at all (a provider doc).
     and (d ? 'kind') = (d ? 'custom')
     and (not d ? 'kind'
          or d ->> 'kind' in ('claude-sdk', 'codex', 'acp', 'terminal', 'desktop-app', 'web-app', 'chat-api', 'a2a'))
     and (not d ? 'custom' or jsonb_typeof(d -> 'custom') = 'boolean')
     -- The only name ever uploaded: a custom recipe's own (the hub has no catalog entry for it).
     and (not d ? 'name'
          or (jsonb_typeof(d -> 'name') = 'string' and length(d ->> 'name') between 1 and 60
              and (d -> 'custom') = 'true'::jsonb))
     -- The new state and error codes belong to app docs only.
     and (d ? 'kind' or (d ->> 'state' <> 'available'
          and coalesce(d ->> 'error', '') not in ('launch_failed', 'unsupported_platform', 'install_unavailable',
                                                  'recipe_disabled'))))
  )
$$;

-- ---------------------------------------------------------------- 3. A2A exposures
create table chalito.a2a_exposures (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  exposure_id text primary key check (exposure_id ~ '^a2x_[A-Za-z0-9_-]{16,64}$'),
  app_id text not null check (app_id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  device_id chalito.id not null,
  workspace_label text not null check (char_length(workspace_label) between 1 and 80),
  -- The A2A Agent Card body (packages/protocol AgentCard) without interfaces or security: the
  -- server adds those. Bounded, and never carries recipe commands, paths or keys.
  card jsonb not null check (jsonb_typeof(card) = 'object' and pg_column_size(card) <= 16384
                             and not card ?| array['supportedInterfaces', 'securitySchemes', 'securityRequirements',
                                                   'signatures']),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index a2a_exposures_owner_idx on chalito.a2a_exposures (owner) where revoked_at is null;

alter table chalito.a2a_exposures enable row level security;
create policy a2a_exposures_read on chalito.a2a_exposures for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
create policy server_all on chalito.a2a_exposures for all to chalito_server using (true) with check (true);
create policy gateway_read on chalito.a2a_exposures for select to chalito_gateway using (true);

revoke all on chalito.a2a_exposures from public, anon, authenticated, service_role;
grant select on chalito.a2a_exposures to authenticated;
grant select, insert, update, delete on chalito.a2a_exposures to chalito_server;
grant select on chalito.a2a_exposures to chalito_gateway;

-- ---------------------------------------------------------------- 4. the gateway reads app status
-- Columns only (no updated_at games): which app, on which device, in which state. Never a secret:
-- the status doc is status only (valid_connection_doc above).
grant select (owner, device_id, provider, doc) on chalito.connections to chalito_gateway;
create policy gateway_read on chalito.connections for select to chalito_gateway using (true);

comment on table chalito.a2a_exposures is
  'Agents the owner exposes on the A2A server (ADR 0022 §4). A card only: tasks need link:handoff and a LinkAuthorizer yes.';
