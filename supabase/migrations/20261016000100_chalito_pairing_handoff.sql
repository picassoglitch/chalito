-- First Run phase B (ADR 0028 §3–§4): pairing a computer from a hand-off link, with no terminal.
--
--   * chalito.pairing_codes.cancelled: "No estoy frente a esa computadora" on the approval screen.
--     A cancelled code can't be claimed; the update reaches the computer over the existing
--     pairing broadcast, so its panel shows that the code was declined.
--   * chalito_private.pairing_code_networks: which public network asked for the code, as a keyed
--     hash (IPv4 address or IPv6 /64, never the address) plus a coarse city when the platform
--     sends one. The api compares it with the approving browser's network and, on a mismatch,
--     requires the short code shown on the computer (THREAT_MODEL §4.5, pairing phishing).
--     Server only: no grant to anon, authenticated (so not the pairing watch token, THREAT_MODEL
--     §5) or service_role. Kept only while the code is open: dropped on claim or decline, with
--     the code (cascade), and by a sweep at the code's expiry or 24 hours at most.
--   * chalito_private.pairing_code_viewers: which signed-in clients opened an open code (hand-off
--     link or typed short code). Only one of them may decline it, so knowing a code id isn't
--     enough to cancel someone else's pairing. Server only, same lifetime as the network record.

alter table chalito.pairing_codes add column cancelled boolean not null default false;

create table chalito_private.pairing_code_networks (
  code_id chalito.id primary key references chalito.pairing_codes (code_id) on delete cascade,
  family smallint not null check (family in (4, 6)),
  net_hash text not null check (net_hash ~ '^[0-9a-f]{64}$'),
  city text check (char_length(city) <= 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at <= created_at + interval '24 hours')
);
alter table chalito_private.pairing_code_networks enable row level security;
revoke all on chalito_private.pairing_code_networks from public, anon, authenticated, service_role;
grant select, insert, delete on chalito_private.pairing_code_networks to chalito_server;

create table chalito_private.pairing_code_viewers (
  code_id chalito.id not null references chalito.pairing_codes (code_id) on delete cascade,
  owner chalito.id not null,
  device_id chalito.id not null,
  viewed_at timestamptz not null default now(),
  primary key (code_id, owner, device_id)
);
alter table chalito_private.pairing_code_viewers enable row level security;
revoke all on chalito_private.pairing_code_viewers from public, anon, authenticated, service_role;
grant select, insert, delete on chalito_private.pairing_code_viewers to chalito_server;

-- Claimed or declined: the network record and the viewers have done their job.
create or replace function chalito_private.drop_pairing_network()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito_private.pairing_code_networks where code_id = new.code_id;
  delete from chalito_private.pairing_code_viewers where code_id = new.code_id;
  return null;
end
$$;
revoke execute on function chalito_private.drop_pairing_network() from public;
create trigger pairing_codes_drop_network after update on chalito.pairing_codes
  for each row when ((new.claimed and not old.claimed) or (new.cancelled and not old.cancelled))
  execute function chalito_private.drop_pairing_network();

-- Expired codes are deleted by purge_expired (cascade); this sweep is the 24-hour backstop and
-- also clears a record whose code outlived its own expiry.
create or replace function chalito_private.purge_pairing_networks()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from chalito_private.pairing_code_networks
    where expires_at <= now() or created_at <= now() - interval '24 hours'
    returning 1),
  viewers as (
    delete from chalito_private.pairing_code_viewers v
    where v.viewed_at <= now() - interval '24 hours'
       or not exists (select 1 from chalito.pairing_codes c where c.code_id = v.code_id and c.expires_at > now())
    returning 1)
  select (select count(*)::int from gone)
$$;
revoke execute on function chalito_private.purge_pairing_networks() from public;
select cron.schedule('chalito-purge-pairing-networks', '*/5 * * * *',
  'select chalito_private.purge_pairing_networks()');
