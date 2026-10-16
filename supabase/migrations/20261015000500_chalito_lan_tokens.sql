-- LAN direct path (ADR 0022 §5, M16 phase E; apps/agent/src/lan). Two agents of the same owner on
-- one network authenticate each other with their device keys plus a short-lived LAN pairing token
-- issued here. The token is a 32-byte secret shared by the owner's active agents for one window:
-- it keys the handshake (a device without it can't finish one) and the rotating mDNS id (a device
-- without it can't link an advertisement to anyone). The directory part of the answer (the owner's
-- other active agents and their signing keys) is what each side checks the other's key against.
--
-- The cloud is a directory here, not a root of trust: what a LAN link carries is verified by the
-- receiving agent against its local trusted list exactly as on the cloud path.
--
-- Server-only table; one RPC for agents. Nothing for clients, users, anon or service_role.

create table chalito_private.lan_tokens (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  tid text primary key check (tid ~ '^[A-Za-z0-9_-]{22}$'),
  secret bytea not null check (length(secret) = 32),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- LAN_TOKEN_MAX_TTL_MS in packages/protocol/src/lan.ts.
  constraint lan_tokens_ttl check (expires_at > issued_at and expires_at <= issued_at + interval '15 minutes')
);
create index lan_tokens_owner_expires on chalito_private.lan_tokens (owner, expires_at desc);
alter table chalito_private.lan_tokens enable row level security;
revoke all on chalito_private.lan_tokens from public, anon, authenticated, service_role;

create or replace function chalito_private.b64url(b bytea)
returns text
language sql
immutable
set search_path = ''
as $$ select translate(encode(b, 'base64'), E'+/=\n', '-_') $$;

-- The caller's LAN grant: every live token for its owner (newest first; a new one is minted when the
-- newest has under 5 minutes left) and the owner's other active agents. Only an active agent device
-- (device_ok, role agent) may call it; a revoked device gets nothing on its next call.
create or replace function chalito_private.lan_token()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o text := chalito.jwt_owner();
  me text := chalito.jwt_device_id();
begin
  if o is null or me is null or chalito.jwt_role() is distinct from 'agent' or not chalito_private.device_ok() then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  -- One minter per owner at a time, so two agents asking together get the same token.
  perform pg_advisory_xact_lock(hashtextextended('chalito.lan_tokens:' || o, 0));
  delete from chalito_private.lan_tokens where owner = o and expires_at <= now();
  if not exists (
    select 1 from chalito_private.lan_tokens where owner = o and expires_at > now() + interval '5 minutes'
  ) then
    insert into chalito_private.lan_tokens (owner, tid, secret, expires_at)
    values (o, chalito_private.b64url(extensions.gen_random_bytes(16)), extensions.gen_random_bytes(32),
            now() + interval '15 minutes');
  end if;
  return jsonb_build_object(
    'tokens', (
      select jsonb_agg(jsonb_build_object(
               'tid', t.tid,
               'secret', chalito_private.b64url(t.secret),
               'expires_at', (extract(epoch from t.expires_at) * 1000)::bigint)
             order by t.expires_at desc)
      from (select * from chalito_private.lan_tokens
            where owner = o and expires_at > now() order by expires_at desc limit 4) t),
    'peers', coalesce((
      select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'pub_sign', d.pub_sign) order by d.device_id)
      from chalito.devices d
      where d.owner = o and d.role = 'agent' and not d.revoked and d.device_id <> me), '[]'::jsonb)
  );
end
$$;

-- The exposed RPC: a thin invoker wrapper (security definer stays in chalito_private).
create or replace function chalito.lan_token()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select chalito_private.lan_token() $$;

revoke all on function chalito_private.b64url(bytea), chalito_private.lan_token(), chalito.lan_token()
  from public, anon, authenticated, service_role;
grant execute on function chalito.lan_token(), chalito_private.lan_token() to authenticated;
