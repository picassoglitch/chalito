-- WebAuthn passkeys (D-019/D-034, M5). The credential public key lives on the device record (any
-- member can read it, like the device's other public keys); agents still verify step-ups only
-- against the copy they recorded locally at the reverse check, never this one.

alter table chalito.devices
  add column webauthn_credential_id text unique,
  add column webauthn_public_key text,
  add column webauthn_rp_id text,
  add column webauthn_counter bigint not null default 0,
  add column webauthn_transports text[],
  add column webauthn_created_at timestamptz,
  add constraint devices_webauthn_complete check (
    webauthn_credential_id is null
    or (webauthn_public_key is not null and webauthn_rp_id is not null and webauthn_created_at is not null)
  );

-- One pending challenge per device and purpose, server only, short-lived and single-use.
create table chalito_private.webauthn_challenges (
  owner chalito.id not null,
  device_id chalito.id not null,
  purpose text not null check (purpose in ('register', 'assert')),
  challenge text not null,
  expires_at timestamptz not null,
  primary key (owner, device_id, purpose),
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index webauthn_challenges_expires_at_idx on chalito_private.webauthn_challenges (expires_at);
alter table chalito_private.webauthn_challenges enable row level security;
revoke all on chalito_private.webauthn_challenges from public, anon, authenticated, service_role;
grant select, insert, update, delete on chalito_private.webauthn_challenges to chalito_server;
create policy server_all on chalito_private.webauthn_challenges for all to chalito_server
  using (true) with check (true);

-- The TTL purge also clears stale challenges.
create or replace function chalito_private.purge_expired(batch integer default 5000)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.pairing_codes where ctid in
    (select ctid from chalito.pairing_codes where expires_at <= now() limit batch);
  delete from chalito.commands where ctid in
    (select ctid from chalito.commands where expires_at <= now() limit batch);
  delete from chalito.session_events where ctid in
    (select ctid from chalito.session_events where expires_at <= now() limit batch);
  delete from chalito.call_lines where ctid in
    (select ctid from chalito.call_lines where expires_at <= now() limit batch);
  delete from chalito_private.sso_tokens where ctid in
    (select ctid from chalito_private.sso_tokens where expires_at <= now() limit batch);
  delete from chalito_private.device_nonces where ctid in
    (select ctid from chalito_private.device_nonces where expires_at <= now() limit batch);
  delete from chalito_private.webauthn_challenges where ctid in
    (select ctid from chalito_private.webauthn_challenges where expires_at <= now() limit batch);
end
$$;
revoke execute on function chalito_private.purge_expired(integer) from public, anon, authenticated, service_role;
