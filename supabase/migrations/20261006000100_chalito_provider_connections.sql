-- "Connect your AI" (connect contract, 2026-10-05): each agent reports, per provider, how the
-- person connected it and whether the provider's CLI is ready on that device.
--
-- The status doc grows from {mode, connected, updated_at} to the protocol's ProviderConnectionDoc
-- (packages/protocol/src/provider.ts): {mode: api_key|signin|null, connected, state,
-- cli: {installed, version}, error, at}. Still status only: every key is allowlisted, `error` is
-- a closed code (never free text), `cli` carries no path. The older shape stays valid so rows an
-- earlier agent wrote keep passing the check.

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
    -- ProviderConnectionDoc.
    ((d - array['mode', 'connected', 'state', 'cli', 'error', 'at']) = '{}'::jsonb
     and d ?& array['mode', 'connected', 'state', 'cli', 'error', 'at']
     and (jsonb_typeof(d -> 'mode') = 'null' or d ->> 'mode' in ('api_key', 'signin'))
     and jsonb_typeof(d -> 'connected') = 'boolean'
     and d ->> 'state' in ('not_installed', 'installing', 'needs_auth', 'signing_in', 'connected', 'error',
                           'blocked_by_policy')
     and (d -> 'connected') = to_jsonb(d ->> 'state' = 'connected')
     and jsonb_typeof(d -> 'cli') = 'object'
     and (d -> 'cli' - array['installed', 'version']) = '{}'::jsonb
     and jsonb_typeof(d -> 'cli' -> 'installed') = 'boolean'
     and (jsonb_typeof(d -> 'cli' -> 'version') = 'null'
          or (jsonb_typeof(d -> 'cli' -> 'version') = 'string' and length(d -> 'cli' ->> 'version') <= 64))
     and (jsonb_typeof(d -> 'error') = 'null'
          or d ->> 'error' in ('install_failed', 'install_unconfirmed', 'npm_missing', 'pin_failed', 'signin_failed',
                               'signin_timeout', 'key_invalid', 'keychain_failed', 'status_failed'))
     and jsonb_typeof(d -> 'at') = 'number')
  )
$$;
