-- Connect engine (engine contract v2, 2026-10-06): any AI app, described by a recipe
-- (packages/protocol/src/recipe.ts), on any of the person's computers.
--
-- 1. chalito.connections.provider holds an APP ID (a recipe id) instead of one of the four
--    providers. Existing rows move to their app (anthropic → claude-code, openai → codex,
--    xai → grok, google → gemini); an agent that hasn't updated yet may still write the old names,
--    which the id pattern also accepts, so nothing it writes starts failing.
-- 2. The status doc gains the protocol's AppConnectionDoc: ProviderConnectionDoc plus `kind`,
--    `custom` and (custom recipes only) `name`, the `available` state and four new closed error
--    codes. Earlier shapes stay valid. Still status only: no paths, no free text, no secrets.
-- 3. chalito.sessions gains `kind` (agent | terminal | screen) and `app_id`, generated from the
--    session doc the agent writes (doc.kind, doc.appId; older rows: agent, and the app of their
--    adapter), so old rows stay valid and the agent's write grants don't change.

-- ---------------------------------------------------------------- 1. connections.provider → app id
-- Where an agent already wrote both (it can't today), keep the app-id row.
delete from chalito.connections c
using chalito.connections n
where c.provider in ('anthropic', 'openai', 'xai', 'google')
  and n.owner = c.owner and n.device_id = c.device_id
  and n.provider = case c.provider
                     when 'anthropic' then 'claude-code' when 'openai' then 'codex'
                     when 'xai' then 'grok' when 'google' then 'gemini' end;

update chalito.connections
set provider = case provider
                 when 'anthropic' then 'claude-code' when 'openai' then 'codex'
                 when 'xai' then 'grok' when 'google' then 'gemini' end
where provider in ('anthropic', 'openai', 'xai', 'google');

alter table chalito.connections drop constraint connections_provider;
alter table chalito.connections
  add constraint connections_provider check (provider ~ '^[a-z0-9][a-z0-9-]{1,40}$');

comment on column chalito.connections.provider is
  'App id (recipe id, packages/protocol/src/recipe.ts AppId). Before 2026-10-06: anthropic|openai|xai|google.';

-- ---------------------------------------------------------------- 2. the status doc
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
     and (d -> 'cli' - array['installed', 'version']) = '{}'::jsonb
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
          or d ->> 'kind' in ('claude-sdk', 'codex', 'acp', 'terminal', 'desktop-app', 'web-app'))
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

-- ---------------------------------------------------------------- 3. sessions: kind and app id
alter table chalito.sessions
  add column kind text generated always as (coalesce(doc ->> 'kind', 'agent')) stored,
  add column app_id text generated always as (
    coalesce(doc ->> 'appId',
             case doc ->> 'adapter'
               when 'claude-code' then 'claude-code' when 'codex' then 'codex'
               when 'grok' then 'grok' when 'gemini' then 'gemini' end)) stored;
alter table chalito.sessions
  add constraint sessions_kind check (kind in ('agent', 'terminal', 'screen')),
  add constraint sessions_app_id check (app_id is null or app_id ~ '^[a-z0-9][a-z0-9-]{1,40}$');
create index sessions_owner_kind_idx on chalito.sessions (owner, kind);

comment on column chalito.sessions.kind is 'agent | terminal | screen, from doc.kind (older rows: agent).';
comment on column chalito.sessions.app_id is 'Recipe id, from doc.appId (older rows: the app of doc.adapter).';
