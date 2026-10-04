-- Chalito data layer on the Chalyb hub's Supabase project (ADR 0017).
--
-- Two schemas:
--   chalito          exposed through the Data API (added to `api.schemas`); every table has RLS.
--   chalito_private  NOT exposed. Server-only tables and the security-definer helpers that RLS
--                    policies call. Supabase: "Never create [a security definer function] in a schema
--                    listed under 'Exposed schemas'" (docs/guides/database/postgres/row-level-security).
--
-- Identity. A Chalito principal is one of:
--   user     a hub user's web session                     { owner, chalito_role: "user" }
--   client   a trusted phone/web device                   { owner, device_id, chalito_role: "client" }
--   agent    a device agent                               { owner, device_id, chalito_role: "agent" }
--   pairing  a token scoped to one pairing code           { pairing_code, chalito_role: "pairing" }
-- The Postgres `role` claim is always "authenticated"; Chalito's role lives in `chalito_role`.
-- Where those claims sit in the JWT depends on the token mechanism, which is not decided yet
-- (ADR 0017 §Tokens). `chalito_private.claim_source()` is the single switch:
--   'custom'        Option A/B: tokens minted by Chalito's API. Claims are top level and the
--                   token must carry `iss = "chalito"`, which keeps hub sessions out.
--   'app_metadata'  Supabase Auth users per device. Claims sit under `app_metadata.chalito`
--                   (never `user_metadata`, which users can edit).

create schema if not exists chalito;
create schema if not exists chalito_private;

revoke all on schema chalito from public;
revoke all on schema chalito_private from public;
grant usage on schema chalito to authenticated, service_role;
-- Only so policies can call the helpers below; no table in chalito_private is granted to clients.
grant usage on schema chalito_private to authenticated;
grant usage on schema chalito_private to service_role;

-- New functions are executable by PUBLIC by default (a global default that a per-schema
-- ALTER DEFAULT PRIVILEGES can't revoke), so every migration revokes explicitly.

-- THE switch. Change it with a new migration (`create or replace`), never per request.
create or replace function chalito_private.claim_source()
returns text
language sql
immutable
set search_path = ''
as $$ select 'custom' $$;

comment on function chalito_private.claim_source() is
  'Where Chalito claims live in the JWT: custom (top level, iss=chalito) or app_metadata (app_metadata.chalito). ADR 0017.';

-- The caller's Chalito claims, or null when the token isn't a Chalito token.
create or replace function chalito.jwt_claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case chalito_private.claim_source()
    when 'custom' then case when j ->> 'iss' = 'chalito' then j end
    when 'app_metadata' then case when jsonb_typeof(j -> 'app_metadata' -> 'chalito') = 'object'
                                  then j -> 'app_metadata' -> 'chalito' end
  end
  from (select auth.jwt() as j) as s
$$;

create or replace function chalito.jwt_owner()
returns text language sql stable set search_path = ''
as $$ select chalito.jwt_claims() ->> 'owner' $$;

create or replace function chalito.jwt_device_id()
returns text language sql stable set search_path = ''
as $$ select chalito.jwt_claims() ->> 'device_id' $$;

create or replace function chalito.jwt_role()
returns text language sql stable set search_path = ''
as $$
  select r from (select chalito.jwt_claims() ->> 'chalito_role' as r) as s
  where r in ('user', 'client', 'agent', 'pairing')
$$;

create or replace function chalito.jwt_pairing_code()
returns text language sql stable set search_path = ''
as $$ select chalito.jwt_claims() ->> 'pairing_code' $$;

revoke execute on function chalito_private.claim_source() from public;
revoke execute on function chalito.jwt_claims(), chalito.jwt_owner(), chalito.jwt_device_id(),
  chalito.jwt_role(), chalito.jwt_pairing_code() from public;
grant execute on function chalito_private.claim_source() to authenticated, service_role;
grant execute on function chalito.jwt_claims(), chalito.jwt_owner(), chalito.jwt_device_id(),
  chalito.jwt_role(), chalito.jwt_pairing_code() to authenticated, service_role;
