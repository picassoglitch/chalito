-- The hookup from the database to the escalation engine (apps/notifier). Until now nothing in
-- production published to the notifier: agents insert approvals and session events straight into
-- Postgres, the orchestrator inserts decision approvals, room events go through room_post, and the
-- api writes some notifications rows directly. Each of those now writes a metadata-only message to
-- chalito_private.notify_outbox in the same transaction (idempotent on source_key), and:
--
--   1. a pg_net poke (after commit) POSTs {id, ts} to the notifier, HMAC-signed with a Vault
--      secret, so an approval's push lands in seconds; the notifier claims that row and runs it
--      through the same path as Pub/Sub `notifications` (quiet hours, caps, dedupe);
--   2. a Cloud Scheduler drain every minute (POST /tasks/drain-notify) picks up whatever a poke
--      missed (scale-to-zero, pg_net's unlogged queue lost in a crash, a notifier error).
--
-- Rows are claimed with a lease, so a poke and the drain never both deliver one. Failures retry with
-- backoff; after 10 attempts a row goes `dead` and is alerted. Nothing is dropped.
--
-- Owner setup (docs/GO_LIVE.md): Vault secrets `chalito_notify_poke_url` (the notifier's
-- https://…/internal/notify-poke) and `chalito_notify_poke_secret` (the same value as the notifier's
-- NOTIFY_POKE_SECRET). Without them, or without pg_net, pokes are skipped and the drain delivers.

create table chalito_private.notify_outbox (
  id bigint generated always as identity primary key,
  owner chalito.id not null references chalito.users (id) on delete cascade,
  source_key text not null unique check (char_length(source_key) between 1 and 400),
  message jsonb not null check (jsonb_typeof(message) = 'object' and octet_length(message::text) <= 4096),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notify_outbox_due on chalito_private.notify_outbox (next_attempt_at) where status in ('pending', 'processing');

alter table chalito_private.notify_outbox enable row level security;
revoke all on chalito_private.notify_outbox from public, anon, authenticated, service_role;
grant select, update on chalito_private.notify_outbox to chalito_server;
create policy server_all on chalito_private.notify_outbox for all to chalito_server using (true) with check (true);

select cron.schedule(
  'chalito-notify-outbox-purge',
  '41 * * * *',
  $$delete from chalito_private.notify_outbox where status = 'sent' and sent_at < now() - interval '7 days'$$
);

-- ---------------------------------------------------------------- poke (pg_net, best effort)
-- Never fails the caller's transaction: no pg_net, no Vault secret, or any error → skip (the drain
-- delivers). The signature covers "<ts>.<id>"; the notifier checks it and a 5-minute window.
create or replace function chalito_private.notify_poke(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_ts text := (floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text;
begin
  if to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'chalito_notify_poke_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'chalito_notify_poke_secret';
  if v_url is null or v_secret is null or v_url !~ '^https://' then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 3000)'
    using v_url,
          jsonb_build_object('id', p_id, 'ts', v_ts::bigint),
          jsonb_build_object('Content-Type', 'application/json',
            'X-Chalito-Poke-Signature', encode(extensions.hmac(v_ts || '.' || p_id::text, v_secret, 'sha256'), 'hex'));
exception when others then
  raise warning 'chalito: notify poke skipped (%)', sqlstate;
end
$$;

create or replace function chalito_private.notify_enqueue(p_owner text, p_key text, p_message jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into chalito_private.notify_outbox (owner, source_key, message)
  values (p_owner, left(p_key, 400), p_message)
  on conflict (source_key) do nothing
  returning id into v_id;
  if v_id is not null then
    perform chalito_private.notify_poke(v_id);
  end if;
end
$$;

create or replace function chalito_private.epoch_ms(t timestamptz)
returns bigint language sql immutable set search_path = ''
as $$ select (floor(extract(epoch from t) * 1000))::bigint $$;

-- ---------------------------------------------------------------- sources
-- Approvals (agents' tool approvals and the orchestrator's decision approvals): pending → notify;
-- resolved → ack (the ladder stops); expired → approval_expired.
create or replace function chalito_private.notify_from_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform chalito_private.notify_enqueue(new.owner, 'approval:' || new.owner || ':' || new.aid, jsonb_build_object(
      'v', 1, 'type', 'notify', 'uid', new.owner,
      'item', jsonb_build_object(
        'nid', new.aid,
        'source', 'approval',
        'urgency', case new.risk when 'LOW' then 'low' when 'MED' then 'normal' when 'HIGH' then 'high' else 'critical' end,
        'level', case new.risk when 'HIGH' then 'L3' when 'CRITICAL' then 'L4' else 'L2' end,
        'counts', jsonb_build_object('approvals', 1, 'questions', 0, 'messages', 0, 'mesas', 0),
        'coalesceKey', 'approval:' || new.aid,
        'deepLink', '/a/' || new.aid,
        'createdAt', chalito_private.epoch_ms(new.created_at),
        'approvalExpiresAt', chalito_private.epoch_ms(new.expires_at))));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status <> 'pending' then
    perform chalito_private.notify_enqueue(new.owner, 'approval_end:' || new.owner || ':' || new.aid,
      case new.status
        when 'expired' then jsonb_build_object('v', 1, 'type', 'approval_expired', 'uid', new.owner, 'nid', new.aid)
        else jsonb_build_object('v', 1, 'type', 'ack', 'uid', new.owner, 'via', 'app', 'nid', new.aid)
      end);
  end if;
  return null;
end
$$;
create trigger notify_outbox_approvals
  after insert or update of status on chalito.approvals
  for each row execute function chalito_private.notify_from_approval();

-- A coding agent's open question (AgentEvent question.asked, written by the device agent).
create or replace function chalito_private.notify_from_session_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.type = 'question.asked' then
    perform chalito_private.notify_enqueue(new.owner, 'question:' || new.owner || ':' || new.sid || ':' || new.eid,
      jsonb_build_object('v', 1, 'type', 'notify', 'uid', new.owner,
        'item', jsonb_build_object(
          'nid', left('q_' || new.sid || '_' || new.eid, 128),
          'source', 'session_question',
          'urgency', 'high',
          'level', 'L3',
          'counts', jsonb_build_object('approvals', 0, 'questions', 1, 'messages', 0, 'mesas', 0),
          'coalesceKey', left('session:' || new.sid, 128),
          'deepLink', '/s/' || new.sid,
          'createdAt', chalito_private.epoch_ms(new.t))));
  end if;
  return null;
end
$$;
create trigger notify_outbox_session_events
  after insert on chalito.session_events
  for each row execute function chalito_private.notify_from_session_event();

-- A room event: a metadata nudge to each addressed co-member (everyone but the sender when not
-- addressed). Only message kinds; presence, enter, leave and ack don't notify.
create or replace function chalito_private.notify_from_room_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  if new.kind not in ('notice', 'event_proposal', 'ask') then
    return null;
  end if;
  for m in
    select rm.uid, rm.companion_id from chalito.room_members rm
    where rm.room_id = new.room_id and rm.companion_id <> new.from_companion_id
      and (cardinality(new.to_companions) = 0 or rm.companion_id = any (new.to_companions))
  loop
    perform chalito_private.notify_enqueue(m.uid, 'room:' || new.room_id || ':' || new.eid || ':' || m.companion_id,
      jsonb_build_object('v', 1, 'type', 'notify', 'uid', m.uid,
        'item', jsonb_build_object(
          'nid', left('room_' || new.room_id || '_' || new.eid, 128),
          'source', 'room_event',
          'urgency', 'normal',
          'level', 'L1',
          'counts', jsonb_build_object('approvals', 0, 'questions', 0, 'messages', 1, 'mesas', 0),
          'coalesceKey', left('room:' || new.room_id, 128),
          'deepLink', '/r/' || new.room_id,
          'createdAt', chalito_private.epoch_ms(new.t))));
  end loop;
  return null;
end
$$;
create trigger notify_outbox_room_events
  after insert on chalito.room_events
  for each row execute function chalito_private.notify_from_room_event();

-- Notifications rows written by anyone but the notifier itself (the api's security alerts and
-- in-app notes). The notifier marks its own transactions with chalito.origin = 'notifier'.
create or replace function chalito_private.notify_from_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('chalito.origin', true), '') = 'notifier' or new.state <> 'pending' then
    return null;
  end if;
  perform chalito_private.notify_enqueue(new.owner, 'notification:' || new.owner || ':' || new.nid,
    jsonb_build_object('v', 1, 'type', 'notify', 'uid', new.owner,
      'item', jsonb_build_object(
        'nid', new.nid,
        'source', new.source,
        'urgency', new.urgency,
        'level', new.level,
        'counts', new.counts,
        'coalesceKey', new.coalesce_key,
        'deepLink', new.deep_link,
        'createdAt', chalito_private.epoch_ms(new.created_at))));
  return null;
end
$$;
create trigger notify_outbox_notifications
  after insert on chalito.notifications
  for each row execute function chalito_private.notify_from_notification();

revoke all on function chalito_private.notify_poke(bigint), chalito_private.notify_enqueue(text, text, jsonb),
  chalito_private.epoch_ms(timestamptz), chalito_private.notify_from_approval(),
  chalito_private.notify_from_session_event(), chalito_private.notify_from_room_event(),
  chalito_private.notify_from_notification()
  from public, anon, authenticated, service_role;
