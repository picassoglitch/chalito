-- Endorsement handoff (ADR 0006, "a new browser of the same account"): a new client device
-- (signed in as the person, not yet trusted) publishes its self-signed registration and gets a
-- code; a trusted client of the same account looks it up, checks the fingerprint, and posts a
-- signed endorsement; the new device hears about it on `chalito:pairing:<code_id>` and fetches it.
--
-- Only Chalito's API (chalito_server) reads or writes the table. The new device waits with the
-- same scoped watch token as an agent waiting on its pairing code (role 'pairing', claim
-- pairing_code = code_id), so the existing realtime policy covers it once pairing_watch_ok also
-- knows endorse codes. Codes live 5 minutes and are swept with the other TTL rows.

create table chalito.endorse_codes (
  code_id chalito.id primary key,
  short_code_hash text not null unique check (short_code_hash ~ '^[0-9a-f]{64}$'),
  owner chalito.id not null references chalito.users (id) on delete cascade,
  new_device_id chalito.id not null,
  registration jsonb not null
    check (jsonb_typeof(registration) = 'object' and octet_length(registration::text) <= 8192),
  endorsement jsonb
    check (endorsement is null or (jsonb_typeof(endorsement) = 'object' and octet_length(endorsement::text) <= 8192)),
  endorsed_by_device_id chalito.id,
  endorsed_at timestamptz,
  -- The new device fetched the endorsement (single use).
  taken_at timestamptz,
  watch_auth_user_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rev bigint not null,
  check ((endorsement is null) = (endorsed_by_device_id is null) and (endorsement is null) = (endorsed_at is null)),
  check (taken_at is null or endorsement is not null)
);
create index endorse_codes_expires_at_idx on chalito.endorse_codes (expires_at);
create index endorse_codes_owner_idx on chalito.endorse_codes (owner);

create trigger bump_rev before insert or update on chalito.endorse_codes
  for each row execute function chalito_private.bump_rev();

alter table chalito.endorse_codes enable row level security;
revoke all on chalito.endorse_codes from public, anon, authenticated, service_role;
grant select, insert, update on chalito.endorse_codes to chalito_server;
create policy server_all on chalito.endorse_codes for all to chalito_server using (true) with check (true);

-- ---------------------------------------------------------------- pointer to the waiting device
-- Only when the endorsement lands (not on the taken_at bookkeeping update).
create or replace function chalito_private.broadcast_endorse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('table', 'endorse_codes', 'op', lower(tg_op),
                       'key', jsonb_build_object('code_id', new.code_id), 'rev', new.rev),
    'endorse_codes', 'chalito:pairing:' || new.code_id, true);
  return null;
end
$$;
revoke execute on function chalito_private.broadcast_endorse() from public, anon, authenticated, service_role;
create trigger endorse_codes_broadcast after update of endorsement on chalito.endorse_codes
  for each row when (old.endorsement is null and new.endorsement is not null)
  execute function chalito_private.broadcast_endorse();

-- ---------------------------------------------------------------- the watcher may join the topic
create or replace function chalito_private.pairing_watch_ok(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select chalito.jwt_role() = 'pairing'
     and p_code = chalito.jwt_pairing_code()
     and (
       exists (select 1 from chalito.pairing_codes c
               where c.code_id = p_code and c.expires_at > now()
                 and (chalito_private.claim_source() = 'custom'
                      or c.watch_auth_user_id::text = chalito.jwt_claims() ->> 'sub'))
       or exists (select 1 from chalito.endorse_codes e
                  where e.code_id = p_code and e.expires_at > now()
                    and (chalito_private.claim_source() = 'custom'
                         or e.watch_auth_user_id::text = chalito.jwt_claims() ->> 'sub'))
     )
$$;

-- ---------------------------------------------------------------- TTL
create or replace function chalito_private.purge_expired(batch integer default 5000)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.pairing_codes where ctid in
    (select ctid from chalito.pairing_codes where expires_at <= now() limit batch);
  delete from chalito.endorse_codes where ctid in
    (select ctid from chalito.endorse_codes where expires_at <= now() limit batch);
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
