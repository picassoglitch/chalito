-- Rooms: tell removed devices to leave (review R-L14), and member reports (abuse/spam).
--
-- R-L14: Realtime authorizes a private channel when it joins (and again on a token refresh), not
-- per message, so a member that left (or was removed, or whose device was revoked) keeps an open
-- channel until its token refreshes. Payloads are pointers and content is sealed to the new key
-- epoch, so what leaks is metadata; still, the server now says so explicitly and the clients
-- (RoomFeed, LiveStore) close the channel at once:
--   * a member row deleted (leave, removal, dissolve) → {table: room_members, op: kicked} on the
--     room topic and on that member's client devices' own topics (re-authorized on every join);
--   * a key rotation already sends {table: rooms, op: update}; RoomFeed re-checks membership;
--   * a device revoked → {table: device_revoked, op: revoked} straight to that device's topic (the
--     usual fan-out skips revoked devices, and RLS then hides its own row). A control message, not
--     a data pointer, so a revoked device is still never pointed at data.
--
-- Reports: a member reports an event or another member to the platform. Server-only table; the
-- reporter's own plaintext copy of the event is kept only when they explicitly attach it.

-- ---------------------------------------------------------------- R-L14
create or replace function chalito_private.room_member_kicked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ptr jsonb := jsonb_build_object('table', 'room_members', 'op', 'kicked',
    'key', jsonb_build_object('room_id', old.room_id, 'companion_id', old.companion_id));
begin
  perform realtime.send(ptr, 'room_members', 'chalito:room:' || old.room_id, true);
  perform chalito_private.send_to_devices(old.uid, 'room_members', ptr, null, 'client');
  return null;
end
$$;
revoke all on function chalito_private.room_member_kicked() from public, anon, authenticated, service_role;
create trigger room_members_kicked after delete on chalito.room_members
  for each row execute function chalito_private.room_member_kicked();

create or replace function chalito_private.device_revoked_pointer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    -- A control message, not a data pointer: nothing to read (RLS hides the row from it now).
    jsonb_build_object('table', 'device_revoked', 'op', 'revoked', 'key', jsonb_build_object('device_id', new.device_id)),
    'device_revoked', 'chalito:device:' || new.device_id, true);
  return null;
end
$$;
revoke all on function chalito_private.device_revoked_pointer() from public, anon, authenticated, service_role;
create trigger devices_revoked_pointer after update of revoked on chalito.devices
  for each row when (new.revoked and not old.revoked)
  execute function chalito_private.device_revoked_pointer();

-- ---------------------------------------------------------------- reports
create table chalito_private.room_reports (
  report_id chalito.id primary key,
  room_id chalito.id not null,
  reporter_uid chalito.id not null,
  reporter_companion_id text not null,
  -- What is reported: an event, a member, or both (an event and its author).
  event_id chalito.id,
  member_companion_id text,
  -- Dedupe key: one report per reporter and target.
  target text not null check (char_length(target) <= 300),
  reason text not null check (reason in ('spam', 'abuse', 'impersonation', 'other')),
  note text check (char_length(note) <= 500),
  -- The reporter's own decrypted copy, only when they chose to attach it.
  attached_plaintext text check (char_length(attached_plaintext) <= 4000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  check (event_id is not null or member_companion_id is not null),
  unique (room_id, reporter_uid, target)
);
create index room_reports_room_idx on chalito_private.room_reports (room_id, created_at);
alter table chalito_private.room_reports enable row level security;
create policy server_all on chalito_private.room_reports for all to chalito_server using (true) with check (true);
revoke all on chalito_private.room_reports from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.room_reports to chalito_server;

-- Creates a report or returns the reporter's existing one for the same target.
create or replace function chalito_private.room_report(
  p_uid text, p_companion text, p_room text, p_report_id text, p_event text, p_member text,
  p_reason text, p_note text, p_plaintext text)
returns table (report_id text, duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_ text;
  existing text;
  author text;
begin
  perform chalito_private.room_assert_member(p_room, p_uid, p_companion);
  if p_event is null and p_member is null then
    perform chalito_private.room_fail('22023', 'report an event or a member');
  end if;
  if p_event is not null then
    select e.from_companion_id into author from chalito.room_events e where e.room_id = p_room and e.eid = p_event;
    if author is null then perform chalito_private.room_fail('PT404', 'event not found'); end if;
  end if;
  if p_member is not null then
    if p_member = p_companion then perform chalito_private.room_fail('22023', 'you can''t report yourself'); end if;
    if not exists (select 1 from chalito.room_members m where m.room_id = p_room and m.companion_id = p_member)
       and p_member is distinct from author then
      perform chalito_private.room_fail('PT404', 'member not found');
    end if;
  end if;
  target_ := coalesce('event:' || p_event, 'member:' || p_member);
  select r.report_id into existing from chalito_private.room_reports r
   where r.room_id = p_room and r.reporter_uid = p_uid and r.target = target_;
  if existing is not null then
    return query select existing::text, true;
    return;
  end if;
  insert into chalito_private.room_reports (report_id, room_id, reporter_uid, reporter_companion_id, event_id,
    member_companion_id, target, reason, note, attached_plaintext)
  values (p_report_id, p_room, p_uid, p_companion, p_event, coalesce(p_member, author), target_, p_reason, p_note,
    p_plaintext)
  on conflict (room_id, reporter_uid, target) do nothing;
  return query select r.report_id::text, r.report_id::text <> p_report_id from chalito_private.room_reports r
    where r.room_id = p_room and r.reporter_uid = p_uid and r.target = target_;
end
$$;
revoke all on function chalito_private.room_report(text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.room_report(text, text, text, text, text, text, text, text, text)
  to chalito_server;
