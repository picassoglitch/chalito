-- M11 rooms (brief §0.6, §5 M11, ADR 0010). Replaces the deny-all stubs.
--
-- Writes: only the api writes, as chalito_server, through the chalito_private.room_* functions
-- below. Each function takes the actor (the hub user id the api verified, and the companion it
-- acts as) and enforces the room rules itself, in one transaction:
--   * a member posts only as their own companion, with the room's current key epoch;
--   * only the owner changes retention or dissolves;
--   * a member removes only their own membership; a leave forces a key rotation before new posts;
--   * invites are single-use by default, expire, and are stored only as hashes.
-- Reads: clients read through RLS, members only. A removed member reads nothing more, and new
-- content is sealed under an epoch key they never received.
-- Content is always sealed with the room key (RoomSealed); the database never sees plaintext.
-- Messaging is notifications, not commands: the event kinds carry no instruction (ADR 0010).

drop table if exists chalito.room_events, chalito.room_members, chalito.room_invites, chalito.rooms,
  chalito.companion_directory, chalito.records cascade;

-- ================================================================ tables
create table chalito.rooms (
  room_id chalito.id primary key,
  type text not null check (type in ('family', 'business', 'project')),
  name text not null check (char_length(name) between 1 and 60),
  owner_uid chalito.id not null references chalito.users (id) on delete cascade,
  owner_companion_id text not null,
  -- rooms.yaml allowedEphemeralTtl.
  ephemeral_ttl text not null default 'PT24H' check (ephemeral_ttl in ('PT1H', 'PT24H', 'P7D', 'P30D', 'until_dissolved')),
  keep_promoted boolean not null default true,
  key_epoch integer not null default 1 check (key_epoch > 0),
  -- Set when a member leaves; posts are refused until a remaining member rotates the key.
  needs_rotation boolean not null default false,
  created_at timestamptz not null default now(),
  rev bigint not null default 0,
  foreign key (owner_uid, owner_companion_id) references chalito.companions (owner, companion_id) on delete cascade
);
create index rooms_owner_idx on chalito.rooms (owner_uid);

create table chalito.room_members (
  room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  companion_id text not null,
  uid chalito.id not null,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  presence jsonb not null default '{"state": "offline"}',
  share_urgency boolean not null default false,
  rev bigint not null default 0,
  primary key (room_id, companion_id),
  foreign key (uid, companion_id) references chalito.companions (owner, companion_id) on delete cascade
);
create index room_members_uid_idx on chalito.room_members (uid, room_id);

-- The room key for one epoch, sealed to one client device of a member.
create table chalito.room_member_keys (
  room_id chalito.id not null,
  companion_id text not null,
  uid chalito.id not null,
  device_id chalito.id not null,
  epoch integer not null check (epoch > 0),
  ct text not null check (ct ~ '^[A-Za-z0-9_-]{107,108}$'), -- 80-byte sealed box, base64url
  created_at timestamptz not null default now(),
  primary key (room_id, device_id, epoch),
  foreign key (room_id, companion_id) references chalito.room_members (room_id, companion_id) on delete cascade,
  foreign key (uid, device_id) references chalito.devices (owner, device_id) on delete cascade
);

create table chalito.room_events (
  room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  eid chalito.id not null,
  from_companion_id text not null,
  to_companions text[] not null default '{}' check (cardinality(to_companions) <= 50),
  kind text not null check (kind in ('notice', 'event_proposal', 'ask', 'ack', 'enter', 'leave', 'presence')),
  urgency text not null default 'low' check (urgency in ('low', 'normal', 'high', 'critical')),
  ct jsonb not null check (jsonb_typeof(ct) = 'object' and ct ->> 'alg' = 'xchacha20poly1305'
                           and octet_length(ct::text) <= 16384),
  key_epoch integer not null check (key_epoch > 0),
  promoted boolean not null default false,
  promoted_by text[] not null default '{}',
  t timestamptz not null default now(),
  -- Null when retention is until_dissolved, or once promoted with keepPromoted.
  expires_at timestamptz,
  rev bigint not null default 0,
  primary key (room_id, eid)
);
create index room_events_room_rev_idx on chalito.room_events (room_id, rev);
create index room_events_expires_at_idx on chalito.room_events (expires_at) where expires_at is not null;

-- Invites: only hashes of the glyph payload and the short code are stored.
create table chalito.room_invites (
  invite_id chalito.id primary key,
  room_id chalito.id not null references chalito.rooms (room_id) on delete cascade,
  created_by_companion_id text not null,
  glyph_payload_hash text not null unique check (glyph_payload_hash ~ '^[0-9a-f]{64}$'),
  short_code_hash text not null unique check (short_code_hash ~ '^[0-9a-f]{64}$'),
  max_uses integer not null default 1 check (max_uses between 1 and 50),
  uses integer not null default 0 check (uses >= 0),
  claimed_by text[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index room_invites_expires_at_idx on chalito.room_invites (expires_at);

-- What co-members may see about each other's companions. Companions aren't searchable.
create table chalito.companion_directory (
  companion_id text primary key,
  owner chalito.id not null,
  display_name text not null check (char_length(display_name) between 1 and 40),
  is_renamed boolean not null default false,
  avatar_thumb text,
  created_at timestamptz not null default now(),
  foreign key (owner, companion_id) references chalito.companions (owner, companion_id) on delete cascade
);

-- The actor's durable copies (promotion). They survive the room's dissolution.
create table chalito.records (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  rid chalito.id not null,
  kind text not null check (kind in ('reminder', 'decision', 'transcript', 'note')),
  source jsonb not null default '{}',
  -- Sealed to the owner's own devices by their client (SealedEnvelope), or a GCS reference.
  ct jsonb,
  gcs_path text,
  created_at timestamptz not null default now(),
  rev bigint not null default 0,
  primary key (owner, rid),
  check (ct is not null or gcs_path is not null)
);

do $$
declare
  t text;
begin
  foreach t in array array['rooms', 'room_members', 'room_events', 'records'] loop
    execute format('create trigger bump_rev before insert or update on chalito.%I
                    for each row execute function chalito_private.bump_rev()', t);
  end loop;
end
$$;

alter table chalito.rooms enable row level security;
alter table chalito.room_members enable row level security;
alter table chalito.room_member_keys enable row level security;
alter table chalito.room_events enable row level security;
alter table chalito.room_invites enable row level security;
alter table chalito.companion_directory enable row level security;
alter table chalito.records enable row level security;

-- ================================================================ read access (clients)
-- The caller's companion in a room, for the person's own principals (web session or devices).
create or replace function chalito_private.my_room_companion(p_room text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.companion_id from chalito.room_members m
  where m.room_id = p_room and m.uid = chalito.jwt_owner() and chalito_private.member_ok()
  limit 1
$$;

create or replace function chalito_private.is_room_member(p_room text)
returns boolean language sql stable security definer set search_path = ''
as $$ select chalito_private.my_room_companion(p_room) is not null $$;

create policy rooms_read on chalito.rooms for select to authenticated
  using (chalito_private.is_room_member(room_id));
create policy room_members_read on chalito.room_members for select to authenticated
  using (chalito_private.is_room_member(room_id));
-- Each device reads only the keys sealed to itself.
create policy room_member_keys_own on chalito.room_member_keys for select to authenticated
  using (uid = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_client()) and chalito_private.is_room_member(room_id));
-- Expired events are invisible at once (the purge deletes them later).
create policy room_events_read on chalito.room_events for select to authenticated
  using (chalito_private.is_room_member(room_id) and (expires_at is null or expires_at > now()));
create policy companion_directory_co_members on chalito.companion_directory for select to authenticated
  using (owner = (select chalito.jwt_owner())
         or exists (select 1 from chalito.room_members theirs
                    where theirs.companion_id = companion_directory.companion_id
                      and chalito_private.is_room_member(theirs.room_id)));
create policy records_read on chalito.records for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));
create policy records_client_delete on chalito.records for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.active_client()));

revoke all on chalito.rooms, chalito.room_members, chalito.room_member_keys, chalito.room_events, chalito.room_invites,
  chalito.companion_directory, chalito.records from public, anon, authenticated, service_role;
grant select on chalito.rooms, chalito.room_members, chalito.room_member_keys, chalito.room_events,
  chalito.companion_directory, chalito.records to authenticated;
grant delete on chalito.records to authenticated;

-- ================================================================ server writes (api)
create policy server_all on chalito.rooms for all to chalito_server using (true) with check (true);
create policy server_all on chalito.room_members for all to chalito_server using (true) with check (true);
create policy server_all on chalito.room_member_keys for all to chalito_server using (true) with check (true);
create policy server_all on chalito.room_events for all to chalito_server using (true) with check (true);
create policy server_all on chalito.room_invites for all to chalito_server using (true) with check (true);
create policy server_all on chalito.companion_directory for all to chalito_server using (true) with check (true);
create policy server_all on chalito.records for all to chalito_server using (true) with check (true);
grant select, insert, update, delete on chalito.rooms, chalito.room_members, chalito.room_member_keys,
  chalito.room_events, chalito.room_invites, chalito.companion_directory, chalito.records to chalito_server;

create or replace function chalito_private.room_fail(p_code text, p_msg text)
returns void language plpgsql immutable set search_path = ''
as $$ begin raise exception 'chalito: %', p_msg using errcode = p_code; end $$;

-- The companion must be the actor's own.
create or replace function chalito_private.room_assert_own_companion(p_uid text, p_companion text)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from chalito.companions c where c.owner = p_uid and c.companion_id = p_companion) then
    perform chalito_private.room_fail('42501', 'not your companion');
  end if;
end
$$;

create or replace function chalito_private.room_assert_member(p_room text, p_uid text, p_companion text)
returns chalito.rooms
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  select * into r from chalito.rooms where room_id = p_room;
  if not found then perform chalito_private.room_fail('PT404', 'room not found'); end if;
  if not exists (select 1 from chalito.room_members m
                 where m.room_id = p_room and m.companion_id = p_companion and m.uid = p_uid) then
    perform chalito_private.room_fail('42501', 'not a member of this room');
  end if;
  return r;
end
$$;

-- Wrapped keys must target active client devices of the member they're for, at `p_epoch`.
create or replace function chalito_private.room_put_keys(p_room text, p_companion text, p_epoch integer, p_wrapped jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m chalito.room_members;
  dev text;
  ct text;
begin
  select * into m from chalito.room_members where room_id = p_room and companion_id = p_companion;
  if not found then perform chalito_private.room_fail('PT404', 'member not found'); end if;
  if jsonb_typeof(p_wrapped) is distinct from 'object' then
    perform chalito_private.room_fail('22023', 'wrapped keys must be {deviceId: ct}');
  end if;
  for dev, ct in select key, value #>> '{}' from jsonb_each(p_wrapped) loop
    if not exists (select 1 from chalito.devices d where d.owner = m.uid and d.device_id = dev
                   and d.role = 'client' and not d.revoked) then
      perform chalito_private.room_fail('22023', 'keys go only to the member''s active client devices');
    end if;
    insert into chalito.room_member_keys (room_id, companion_id, uid, device_id, epoch, ct)
    values (p_room, p_companion, m.uid, dev, p_epoch, ct)
    on conflict (room_id, device_id, epoch) do update set ct = excluded.ct;
  end loop;
end
$$;

-- Create: the owner's companion becomes the owner member; epoch 1 wrapped to its client devices.
create or replace function chalito_private.room_create(
  p_uid text, p_companion text, p_room text, p_type text, p_name text, p_wrapped jsonb, p_room_limit integer,
  p_ttl text default 'PT24H', p_keep_promoted boolean default true)
returns chalito.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  perform chalito_private.room_assert_own_companion(p_uid, p_companion);
  perform pg_advisory_xact_lock(hashtext('chalito.rooms:' || p_uid));
  if (select count(*) from chalito.rooms where owner_uid = p_uid) >= coalesce(p_room_limit, 0) then
    perform chalito_private.room_fail('PT402', 'room limit for this plan');
  end if;
  insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id, ephemeral_ttl, keep_promoted)
  values (p_room, p_type, p_name, p_uid, p_companion, p_ttl, p_keep_promoted)
  returning * into r;
  insert into chalito.room_members (room_id, companion_id, uid, role) values (p_room, p_companion, p_uid, 'owner');
  perform chalito_private.room_put_keys(p_room, p_companion, 1, p_wrapped);
  return r;
end
$$;

create or replace function chalito_private.room_invite(
  p_uid text, p_companion text, p_room text, p_invite text, p_glyph_hash text, p_short_hash text,
  p_max_uses integer, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform chalito_private.room_assert_member(p_room, p_uid, p_companion);
  insert into chalito.room_invites (invite_id, room_id, created_by_companion_id, glyph_payload_hash,
    short_code_hash, max_uses, expires_at)
  values (p_invite, p_room, p_companion, p_glyph_hash, p_short_hash, p_max_uses, p_expires_at);
end
$$;

-- Join with an invite (by short-code or glyph hash). Keys are wrapped afterwards by a member.
create or replace function chalito_private.room_join(
  p_uid text, p_companion text, p_hash text, p_member_limit integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv chalito.room_invites;
begin
  perform chalito_private.room_assert_own_companion(p_uid, p_companion);
  select * into inv from chalito.room_invites
  where short_code_hash = p_hash or glyph_payload_hash = p_hash
  for update;
  if not found or inv.expires_at <= now() then perform chalito_private.room_fail('PT404', 'invite not found'); end if;
  if exists (select 1 from chalito.room_members where room_id = inv.room_id and companion_id = p_companion) then
    perform chalito_private.room_fail('PT409', 'already a member');
  end if;
  if inv.uses >= inv.max_uses then perform chalito_private.room_fail('PT410', 'invite used'); end if;
  perform pg_advisory_xact_lock(hashtext('chalito.room:' || inv.room_id));
  if (select count(*) from chalito.room_members where room_id = inv.room_id) >= coalesce(p_member_limit, 0) then
    perform chalito_private.room_fail('PT402', 'member limit for this plan');
  end if;
  insert into chalito.room_members (room_id, companion_id, uid, role) values (inv.room_id, p_companion, p_uid, 'member');
  update chalito.room_invites set uses = uses + 1, claimed_by = claimed_by || p_companion where invite_id = inv.invite_id;
  return inv.room_id;
end
$$;

-- A member's client wraps the current key to a (new) member's devices.
create or replace function chalito_private.room_wrap_keys(
  p_uid text, p_companion text, p_room text, p_target text, p_epoch integer, p_wrapped jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if p_epoch <> r.key_epoch then perform chalito_private.room_fail('PT409', 'stale key epoch'); end if;
  perform chalito_private.room_put_keys(p_room, p_target, p_epoch, p_wrapped);
end
$$;

-- Leave: only your own membership. The owner dissolves instead. The room needs a new epoch.
create or replace function chalito_private.room_leave(p_uid text, p_companion text, p_room text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if r.owner_companion_id = p_companion then
    perform chalito_private.room_fail('PT409', 'the owner dissolves the room instead of leaving');
  end if;
  delete from chalito.room_members where room_id = p_room and companion_id = p_companion;
  update chalito.rooms set needs_rotation = true where room_id = p_room;
end
$$;

-- Rotate: a remaining member installs epoch+1, wrapped to every remaining member's devices.
create or replace function chalito_private.room_rotate(
  p_uid text, p_companion text, p_room text, p_epoch integer, p_wrapped jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
  target text;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if p_epoch <> r.key_epoch + 1 then perform chalito_private.room_fail('PT409', 'rotation must be to the next epoch'); end if;
  if jsonb_typeof(p_wrapped) is distinct from 'object' then
    perform chalito_private.room_fail('22023', 'wrapped keys must be {companionId: {deviceId: ct}}');
  end if;
  -- Every remaining member must receive the new key.
  if exists (select 1 from chalito.room_members m where m.room_id = p_room and not p_wrapped ? m.companion_id)
     or exists (select 1 from jsonb_object_keys(p_wrapped) k
                where not exists (select 1 from chalito.room_members m where m.room_id = p_room and m.companion_id = k)) then
    perform chalito_private.room_fail('22023', 'the new key goes to exactly the remaining members');
  end if;
  for target in select jsonb_object_keys(p_wrapped) loop
    perform chalito_private.room_put_keys(p_room, target, p_epoch, p_wrapped -> target);
  end loop;
  update chalito.rooms set key_epoch = p_epoch, needs_rotation = false where room_id = p_room;
end
$$;

-- Dissolve (owner): events, members, keys and invites go; promoted records stay with their owners.
create or replace function chalito_private.room_dissolve(p_uid text, p_companion text, p_room text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if r.owner_companion_id <> p_companion then perform chalito_private.room_fail('42501', 'only the owner dissolves'); end if;
  perform realtime.send(jsonb_build_object('table', 'rooms', 'op', 'dissolve', 'key', jsonb_build_object('room_id', p_room)),
    'rooms', 'chalito:room:' || p_room, true);
  delete from chalito.rooms where room_id = p_room; -- cascades to members, keys, events, invites
end
$$;

-- Post: as the actor's own member companion, with the current epoch; the server stamps t and
-- expires_at from the room's retention.
create or replace function chalito_private.room_post(
  p_uid text, p_companion text, p_room text, p_eid text, p_to text[], p_kind text, p_urgency text,
  p_ct jsonb, p_epoch integer)
returns chalito.room_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
  e chalito.room_events;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if r.needs_rotation then perform chalito_private.room_fail('PT409', 'key rotation pending'); end if;
  if p_epoch <> r.key_epoch or (p_ct ->> 'epoch')::int is distinct from r.key_epoch then
    perform chalito_private.room_fail('PT409', 'stale key epoch');
  end if;
  if exists (select 1 from unnest(coalesce(p_to, '{}')) t
             where not exists (select 1 from chalito.room_members m where m.room_id = p_room and m.companion_id = t)) then
    perform chalito_private.room_fail('22023', 'addressed companions must be members');
  end if;
  insert into chalito.room_events (room_id, eid, from_companion_id, to_companions, kind, urgency, ct, key_epoch, t, expires_at)
  values (p_room, p_eid, p_companion, coalesce(p_to, '{}'), p_kind, coalesce(p_urgency, 'low'), p_ct, r.key_epoch, now(),
    case r.ephemeral_ttl when 'until_dissolved' then null else now() + r.ephemeral_ttl::interval end)
  returning * into e;
  return e;
end
$$;

-- Promote: a durable copy for the actor (sealed to their own devices by their client), and the
-- event loses its expiry when the room keeps promoted events.
create or replace function chalito_private.room_promote(
  p_uid text, p_companion text, p_room text, p_eid text, p_rid text, p_kind text, p_ct jsonb)
returns chalito.records
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
  rec chalito.records;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if not exists (select 1 from chalito.room_events where room_id = p_room and eid = p_eid
                 and (expires_at is null or expires_at > now())) then
    perform chalito_private.room_fail('PT404', 'event not found');
  end if;
  insert into chalito.records (owner, rid, kind, source, ct)
  values (p_uid, p_rid, p_kind, jsonb_build_object('roomId', p_room, 'eventId', p_eid), p_ct)
  returning * into rec;
  update chalito.room_events
  set promoted = true,
      promoted_by = case when p_companion = any (promoted_by) then promoted_by else promoted_by || p_companion end,
      expires_at = case when r.keep_promoted then null else expires_at end
  where room_id = p_room and eid = p_eid;
  return rec;
end
$$;

-- Retention: owner only (the api audits the change; members see it on the room row).
create or replace function chalito_private.room_set_retention(
  p_uid text, p_companion text, p_room text, p_ttl text, p_keep_promoted boolean)
returns chalito.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  r chalito.rooms;
begin
  r := chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if r.owner_companion_id <> p_companion then
    perform chalito_private.room_fail('42501', 'only the owner changes retention');
  end if;
  update chalito.rooms set ephemeral_ttl = p_ttl, keep_promoted = p_keep_promoted where room_id = p_room returning * into r;
  return r;
end
$$;

-- ================================================================ realtime: chalito:room:<id>
create or replace function chalito_private.broadcast_room()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_ jsonb := to_jsonb(coalesce(new, old));
begin
  perform realtime.send(
    jsonb_build_object('table', tg_table_name, 'op', lower(tg_op),
      'key', case tg_table_name
        when 'room_events' then jsonb_build_object('room_id', row_ -> 'room_id', 'eid', row_ -> 'eid', 'kind', row_ -> 'kind',
                                                   'to', row_ -> 'to_companions')
        when 'room_members' then jsonb_build_object('room_id', row_ -> 'room_id', 'companion_id', row_ -> 'companion_id')
        else jsonb_build_object('room_id', row_ -> 'room_id') end,
      'rev', row_ -> 'rev'),
    tg_table_name, 'chalito:room:' || (row_ ->> 'room_id'), true);
  return null;
end
$$;
create trigger room_events_broadcast after insert or update on chalito.room_events
  for each row execute function chalito_private.broadcast_room();
create trigger room_members_broadcast after insert or delete on chalito.room_members
  for each row execute function chalito_private.broadcast_room();
create trigger rooms_broadcast after update on chalito.rooms
  for each row execute function chalito_private.broadcast_room();

-- Extend the topic check: room topics are readable by members (web session or devices).
create or replace function chalito_private.realtime_topic_ok(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic = 'chalito:device:' || chalito.jwt_device_id() then chalito_private.device_ok()
    when p_topic = 'chalito:pairing:' || chalito.jwt_pairing_code() then chalito_private.pairing_watch_ok(chalito.jwt_pairing_code())
    when p_topic like 'chalito:room:%' then chalito_private.is_room_member(substr(p_topic, length('chalito:room:') + 1))
    else false
  end
$$;

-- ================================================================ TTL
create or replace function chalito_private.purge_room_events(batch integer default 5000)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.room_events where ctid in
    (select ctid from chalito.room_events where expires_at <= now() limit batch);
  delete from chalito.room_invites where ctid in
    (select ctid from chalito.room_invites where expires_at <= now() limit batch);
end
$$;
select cron.schedule('chalito-purge-rooms', '* * * * *', 'select chalito_private.purge_room_events()');

-- ================================================================ privileges
revoke all on function chalito_private.my_room_companion(text), chalito_private.is_room_member(text),
  chalito_private.room_fail(text, text), chalito_private.room_assert_own_companion(text, text),
  chalito_private.room_assert_member(text, text, text), chalito_private.room_put_keys(text, text, integer, jsonb),
  chalito_private.room_create(text, text, text, text, text, jsonb, integer, text, boolean),
  chalito_private.room_invite(text, text, text, text, text, text, integer, timestamptz),
  chalito_private.room_join(text, text, text, integer),
  chalito_private.room_wrap_keys(text, text, text, text, integer, jsonb),
  chalito_private.room_leave(text, text, text), chalito_private.room_rotate(text, text, text, integer, jsonb),
  chalito_private.room_dissolve(text, text, text),
  chalito_private.room_post(text, text, text, text, text[], text, text, jsonb, integer),
  chalito_private.room_promote(text, text, text, text, text, text, jsonb),
  chalito_private.room_set_retention(text, text, text, text, boolean), chalito_private.broadcast_room(),
  chalito_private.purge_room_events(integer)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.my_room_companion(text), chalito_private.is_room_member(text)
  to authenticated;
grant execute on function
  chalito_private.room_create(text, text, text, text, text, jsonb, integer, text, boolean),
  chalito_private.room_invite(text, text, text, text, text, text, integer, timestamptz),
  chalito_private.room_join(text, text, text, integer),
  chalito_private.room_wrap_keys(text, text, text, text, integer, jsonb),
  chalito_private.room_leave(text, text, text), chalito_private.room_rotate(text, text, text, integer, jsonb),
  chalito_private.room_dissolve(text, text, text),
  chalito_private.room_post(text, text, text, text, text[], text, text, jsonb, integer),
  chalito_private.room_promote(text, text, text, text, text, text, jsonb),
  chalito_private.room_set_retention(text, text, text, text, boolean)
  to chalito_server;
