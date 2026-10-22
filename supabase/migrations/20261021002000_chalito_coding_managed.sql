-- ADR 0030: managed coding agents. Token hashes are server-only; owners read their own cap and spend;
-- chalito_ai_gateway (apps/ai-gateway) writes only metering: credential counters, daily spend, coding usage.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chalito_ai_gateway') then
    create role chalito_ai_gateway nologin nobypassrls;
  end if;
end
$$;
grant chalito_ai_gateway to postgres with inherit false, set true;
grant usage on schema chalito, chalito_private to chalito_ai_gateway;

-- ---------------------------------------------------------------- credentials
create table chalito_private.coding_credentials (
  -- Public id (safe to log); the token itself is never stored.
  id text primary key check (id ~ '^cc_[0-9a-f]{32}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  owner chalito.id not null references chalito.users (id) on delete cascade,
  device_id chalito.id not null,
  sid chalito.id not null,
  agent text not null check (agent in ('codex', 'gemini-cli', 'grok-build')),
  provider text not null check (provider in ('openai', 'google', 'xai')),
  models text[] not null check (cardinality(models) between 1 and 16),
  -- The hub hold: external_job_id `coding:<id>:<hold_gen>`; a lapsed hold is replaced (gen + 1).
  hold_gen integer not null default 0 check (hold_gen >= 0),
  reservation_id uuid,
  -- Worst-case provider cost of requests in flight, and what this credential has billed so far.
  inflight_micros bigint not null default 0 check (inflight_micros >= 0),
  inflight_requests integer not null default 0 check (inflight_requests >= 0),
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  requests integer not null default 0 check (requests >= 0),
  blocked_reason text check (blocked_reason in ('out_of_energy', 'daily_cap')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in
    ('session_end', 'reissued', 'kill_switch', 'device_revoked', 'expired', 'owner')),
  settled_at timestamptz,
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_reason is null)),
  check ((agent, provider) in (('codex', 'openai'), ('gemini-cli', 'google'), ('grok-build', 'xai')))
);
create unique index coding_credentials_one_live on chalito_private.coding_credentials (owner, device_id, sid, agent)
  where revoked_at is null;
create index coding_credentials_device_live on chalito_private.coding_credentials (owner, device_id)
  where revoked_at is null;
-- The gateway's sweep: holds still open on expired or revoked credentials.
create index coding_credentials_unsettled on chalito_private.coding_credentials (expires_at)
  where settled_at is null;

alter table chalito_private.coding_credentials enable row level security;
revoke all on chalito_private.coding_credentials from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.coding_credentials to chalito_server;
create policy server_all on chalito_private.coding_credentials for all to chalito_server using (true) with check (true);
grant select on chalito_private.coding_credentials to chalito_ai_gateway;
grant update (hold_gen, reservation_id, inflight_micros, inflight_requests, spent_micros, requests, blocked_reason,
              revoked_at, revoked_reason, settled_at)
  on chalito_private.coding_credentials to chalito_ai_gateway;
create policy ai_gateway_read on chalito_private.coding_credentials for select to chalito_ai_gateway using (true);
create policy ai_gateway_meter on chalito_private.coding_credentials for update to chalito_ai_gateway
  using (true) with check (true);

-- ---------------------------------------------------------------- settings
create table chalito.coding_settings (
  owner chalito.id primary key references chalito.users (id) on delete cascade,
  -- Null: providers.yaml codingManaged.dailyCap.default.
  daily_cap_tokens bigint check (daily_cap_tokens between 0 and 100000000000),
  -- The cap's day follows this zone, frozen at first use; a users.tz change takes over when that day ends.
  cap_tz text check (cap_tz is null or char_length(cap_tz) between 1 and 64),
  cap_tz_next text check (cap_tz_next is null or char_length(cap_tz_next) between 1 and 64),
  cap_tz_from timestamptz,
  updated_at timestamptz not null default now(),
  check ((cap_tz_next is null) = (cap_tz_from is null))
);
alter table chalito.coding_settings enable row level security;
revoke all on chalito.coding_settings from public, anon, authenticated, service_role;
grant select on chalito.coding_settings to authenticated;
create policy owner_read on chalito.coding_settings for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
grant select, insert, update on chalito.coding_settings to chalito_server;
create policy server_all on chalito.coding_settings for all to chalito_server using (true) with check (true);
grant select on chalito.coding_settings to chalito_ai_gateway;
create policy ai_gateway_read on chalito.coding_settings for select to chalito_ai_gateway using (true);

-- ---------------------------------------------------------------- daily spend
create table chalito.coding_spend_daily (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  -- The owner's local calendar day (users.tz) when the request finished.
  day date not null,
  agent text not null check (agent in ('codex', 'gemini-cli', 'grok-build')),
  cost_usd_micros bigint not null default 0 check (cost_usd_micros >= 0),
  -- What the hub will draw at its default margin, for the cap (the hub's own figure may differ).
  billable_tokens bigint not null default 0 check (billable_tokens >= 0),
  requests integer not null default 0 check (requests >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner, day, agent)
);
alter table chalito.coding_spend_daily enable row level security;
revoke all on chalito.coding_spend_daily from public, anon, authenticated, service_role;
grant select on chalito.coding_spend_daily to authenticated;
create policy owner_read on chalito.coding_spend_daily for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
grant select on chalito.coding_spend_daily to chalito_server;
create policy server_read on chalito.coding_spend_daily for select to chalito_server using (true);
grant select, insert, update on chalito.coding_spend_daily to chalito_ai_gateway;
create policy ai_gateway_all on chalito.coding_spend_daily for all to chalito_ai_gateway using (true) with check (true);

-- Rows older than 400 days are no longer shown or capped against.
select cron.schedule(
  'chalito-coding-spend-purge',
  '41 4 * * *',
  $$delete from chalito.coding_spend_daily where day < current_date - 400$$
);

-- ---------------------------------------------------------------- what the gateway reads and writes elsewhere
-- The owner's tier (paid tiers only) and time zone (the cap's day).
grant select (id, tier, tz) on chalito.users to chalito_ai_gateway;
create policy ai_gateway_read on chalito.users for select to chalito_ai_gateway using (true);
-- Usage events, in the same transaction as the metering; select for the unsent part of a hold.
grant select, insert on chalito_private.usage_outbox to chalito_ai_gateway;
create policy ai_gateway_insert on chalito_private.usage_outbox for insert to chalito_ai_gateway
  with check (event ->> 'source_id' like 'coding:%');
create policy ai_gateway_read on chalito_private.usage_outbox for select to chalito_ai_gateway
  using (source_id like 'coding:%');
-- A device revoked since its credential was issued is refused on the next request.
grant select (owner, device_id, revoked) on chalito.devices to chalito_ai_gateway;
create policy ai_gateway_read on chalito.devices for select to chalito_ai_gateway using (true);

-- ---------------------------------------------------------------- the "chalyb" connect method
-- An agent reports a coding agent connected on "IA de Chalyb" (mode chalyb); otherwise as in 20261015000400.
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
     and (jsonb_typeof(d -> 'mode') = 'null' or d ->> 'mode' in ('api_key', 'signin', 'chalyb'))
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
