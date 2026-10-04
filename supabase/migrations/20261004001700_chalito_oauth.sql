-- M10: Chalito's OAuth 2.1 authorization server for the MCP gateway (ADR 0009, D-017).
-- Clients (CIMD documents fetched and cached, or DCR registrations), pending authorization
-- requests, grants (the user-visible "connectors", revocable at once), single-use codes, and
-- access/refresh tokens. Tokens and codes are stored only as SHA-256 hashes. Everything here is
-- written by the api (chalito_server); the gateway (001800) only reads tokens and grants.

-- The only scopes that exist. Never approval:decide, device admin, policy, devmode, rooms or billing.
create or replace function chalito_private.mcp_scopes()
returns text[] language sql immutable set search_path = ''
as $$ select array['mcp:read', 'mesa:post', 'approval:recommend', 'session:prompt'] $$;

create table chalito_private.oauth_clients (
  client_id text primary key check (char_length(client_id) <= 512),
  kind text not null check (kind in ('cimd', 'dcr')),
  client_name text not null check (char_length(client_name) between 1 and 120),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  fetched_at timestamptz
);

-- An authorization request waiting for the user's consent (shown by the web app).
create table chalito_private.oauth_requests (
  request_id text primary key,
  client_id text not null references chalito_private.oauth_clients (client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  scopes text[] not null check (scopes <@ chalito_private.mcp_scopes()),
  state text check (char_length(state) <= 512),
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index oauth_requests_expires_at_idx on chalito_private.oauth_requests (expires_at);

-- Grants: one per (user, client) authorization. Revoking one cuts every token at once.
drop table if exists chalito.connectors cascade;
create table chalito.connectors (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  cid chalito.id not null,
  client_id text not null,
  client_name text not null,
  provider text not null check (provider in ('claude', 'chatgpt', 'other')),
  scopes text[] not null check (scopes <@ chalito_private.mcp_scopes() and cardinality(scopes) >= 1),
  resource text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  primary key (owner, cid)
);

create table chalito_private.oauth_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  owner chalito.id not null,
  cid chalito.id not null,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  foreign key (owner, cid) references chalito.connectors (owner, cid) on delete cascade
);
create index oauth_codes_expires_at_idx on chalito_private.oauth_codes (expires_at);

create table chalito_private.oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('access', 'refresh')),
  owner chalito.id not null,
  cid chalito.id not null,
  client_id text not null,
  scopes text[] not null,
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Refresh tokens rotate: a used one that comes back again revokes the whole grant.
  used_at timestamptz,
  foreign key (owner, cid) references chalito.connectors (owner, cid) on delete cascade
);
create index oauth_tokens_grant_idx on chalito_private.oauth_tokens (owner, cid);
create index oauth_tokens_expires_at_idx on chalito_private.oauth_tokens (expires_at);

alter table chalito_private.oauth_clients enable row level security;
alter table chalito_private.oauth_requests enable row level security;
alter table chalito.connectors enable row level security;
alter table chalito_private.oauth_codes enable row level security;
alter table chalito_private.oauth_tokens enable row level security;

-- The person sees their own grants (and revokes them through the api).
create policy connectors_read on chalito.connectors for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

create policy server_all on chalito_private.oauth_clients for all to chalito_server using (true) with check (true);
create policy server_all on chalito_private.oauth_requests for all to chalito_server using (true) with check (true);
create policy server_all on chalito.connectors for all to chalito_server using (true) with check (true);
create policy server_all on chalito_private.oauth_codes for all to chalito_server using (true) with check (true);
create policy server_all on chalito_private.oauth_tokens for all to chalito_server using (true) with check (true);

revoke all on chalito_private.oauth_clients, chalito_private.oauth_requests, chalito.connectors,
  chalito_private.oauth_codes, chalito_private.oauth_tokens from public, anon, authenticated, service_role;
grant select on chalito.connectors to authenticated;
grant select, insert, update, delete on chalito_private.oauth_clients, chalito_private.oauth_requests, chalito.connectors,
  chalito_private.oauth_codes, chalito_private.oauth_tokens to chalito_server;
revoke all on function chalito_private.mcp_scopes() from public, anon, service_role;
grant execute on function chalito_private.mcp_scopes() to authenticated, chalito_server;

-- Expired codes, requests and tokens go with the other TTL rows.
create or replace function chalito_private.purge_oauth()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito_private.oauth_codes where expires_at <= now();
  delete from chalito_private.oauth_requests where expires_at <= now();
  delete from chalito_private.oauth_tokens where ctid in
    (select ctid from chalito_private.oauth_tokens where expires_at <= now() limit 5000);
end
$$;
revoke all on function chalito_private.purge_oauth() from public, anon, authenticated, service_role;
select cron.schedule('chalito-purge-oauth', '*/5 * * * *', 'select chalito_private.purge_oauth()');
