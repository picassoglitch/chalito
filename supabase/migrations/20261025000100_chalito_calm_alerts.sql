-- Stuck/stall alerts and calmer alerts (from Alux, by Omar (homiomar), used with his permission).
--
-- 1. An agent's `agent.alert` session event (the session repeats a failing command, or a running turn
--    went quiet) queues an `agent_alert` notification: L2 when stuck, L1 when stalled, one ladder per
--    turn (coalesceKey alert:<sid>:<turn>), so it fires once.
-- 2. The owner's next prompt in a session also acks that session's alerts and open question, not only
--    the "finished" push: they are back on it.
-- 3. Approval items carry their session (`sid`), so "Esperando a alguien" covers them ("seen" leaves
--    approvals alone: they expire in minutes and still need an answer).
-- 4. chalito.notification_action: the person's app reports that a session was opened ("seen"),
--    parked ("waiting") or that one alert was postponed ("snooze"). It only queues a message for the
--    escalation engine (apps/notifier); the outbox dedupes repeats within the same second.
--
-- Deploy order: this migration first (today's notifier drops `agent_alert` as an unknown source and
-- ignores the new ack fields), then the notifier, then the desktop and agent last (a desktop ahead of
-- the notifier would dead-letter every seen / waiting / snooze_alert message).
-- Rollback (forward-only, RUNBOOK 2.3): roll the desktop/agent and the notifier back first, then a new
-- forward migration restores 20261021000200's notify_from_session_event and 20261004003050's
-- notify_from_approval and drops chalito.notification_action and chalito_private.notification_action.

create or replace function chalito_private.notify_from_session_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_end integer;
  v_start timestamptz;
  v_kind text;
  v_turn text;
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
  elsif new.type = 'session.state' and new.doc ->> 'state' in ('idle', 'completed') then
    -- Unchanged from 20261021000200: a turn of 60 s to 30 min queues one "finished" push per 10 min.
    select max(e.seq) into v_prev_end from chalito.session_events e
     where e.owner = new.owner and e.sid = new.sid and e.type = 'session.state' and e.seq < new.seq
       and e.doc ->> 'state' in ('idle', 'completed', 'failed', 'interrupted');
    select min(e.t) into v_start from chalito.session_events e
     where e.owner = new.owner and e.sid = new.sid and e.type = 'session.state' and e.seq < new.seq
       and e.doc ->> 'state' = 'running' and (v_prev_end is null or e.seq > v_prev_end);
    if v_start is not null and new.t - v_start between interval '60 seconds' and interval '30 minutes'
       and not exists (
         select 1 from chalito_private.notify_outbox o
          where o.owner = new.owner and starts_with(o.source_key, 'turn:' || new.owner || ':' || new.sid || ':')
            and (o.message -> 'item' ->> 'createdAt')::bigint > chalito_private.epoch_ms(new.t) - 600000) then
      perform chalito_private.notify_enqueue(new.owner, 'turn:' || new.owner || ':' || new.sid || ':' || new.eid,
        jsonb_build_object('v', 1, 'type', 'notify', 'uid', new.owner,
          'item', jsonb_build_object(
            'nid', left('t_' || new.sid || '_' || new.eid, 128),
            'source', 'turn_finished',
            'urgency', 'low',
            'level', 'L1',
            'counts', jsonb_build_object('approvals', 0, 'questions', 0, 'messages', 1, 'mesas', 0),
            'coalesceKey', left('turn:' || new.sid, 128),
            'deepLink', '/s/' || new.sid,
            'createdAt', chalito_private.epoch_ms(new.t))));
    end if;
  elsif new.type = 'agent.alert' then
    v_kind := new.doc ->> 'kind';
    v_turn := new.doc ->> 'turn';
    -- The doc is the agent's own; anything malformed is ignored rather than failing its batch insert.
    if v_kind in ('stuck', 'stalled') and v_turn ~ '^[0-9]{1,16}$' then
      perform chalito_private.notify_enqueue(new.owner, 'alert:' || new.owner || ':' || new.sid || ':' || new.eid,
        jsonb_build_object('v', 1, 'type', 'notify', 'uid', new.owner,
          'item', jsonb_build_object(
            'nid', left('al_' || new.sid || '_' || v_turn, 128),
            'source', 'agent_alert',
            'urgency', case v_kind when 'stuck' then 'normal' else 'low' end,
            'level', case v_kind when 'stuck' then 'L2' else 'L1' end,
            'counts', jsonb_build_object('approvals', 0, 'questions', 0, 'messages', 0, 'mesas', 0),
            'coalesceKey', left('alert:' || new.sid || ':' || v_turn, 128),
            'deepLink', '/s/' || new.sid,
            'sid', new.sid,
            'createdAt', chalito_private.epoch_ms(new.t))));
    end if;
  elsif new.type = 'message.user' then
    -- The owner prompted again: they are here, so a waiting "finished" push is stale…
    perform chalito_private.notify_enqueue(new.owner, 'turn_ack:' || new.owner || ':' || new.sid || ':' || new.eid,
      jsonb_build_object('v', 1, 'type', 'ack', 'uid', new.owner, 'via', 'app', 'coalesceKey', left('turn:' || new.sid, 128)));
    -- …and so are that session's stuck/stall alerts and its open question (attention lasts until the next prompt).
    -- Only the person's prompts: a coordinator's or a link's (agent:, a2a:) never saw those alerts.
    if coalesce(new.doc ->> 'origin', '') not like 'agent:%' and coalesce(new.doc ->> 'origin', '') not like 'a2a:%' then
      perform chalito_private.notify_enqueue(new.owner, 'session_ack:' || new.owner || ':' || new.sid || ':' || new.eid,
        jsonb_build_object('v', 1, 'type', 'ack', 'uid', new.owner, 'via', 'app', 'sid', new.sid,
          'sources', jsonb_build_array('agent_alert', 'session_question')));
    end if;
  end if;
  return null;
end
$$;

-- Same as 20261004003050, plus the item's `sid`.
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
      'item', jsonb_strip_nulls(jsonb_build_object(
        'nid', new.aid,
        'source', 'approval',
        'urgency', case new.risk when 'LOW' then 'low' when 'MED' then 'normal' when 'HIGH' then 'high' else 'critical' end,
        'level', case new.risk when 'HIGH' then 'L3' when 'CRITICAL' then 'L4' else 'L2' end,
        'counts', jsonb_build_object('approvals', 1, 'questions', 0, 'messages', 0, 'mesas', 0),
        'coalesceKey', 'approval:' || new.aid,
        'deepLink', '/a/' || new.aid,
        'sid', new.sid,
        'createdAt', chalito_private.epoch_ms(new.created_at),
        'approvalExpiresAt', chalito_private.epoch_ms(new.expires_at)))));
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

revoke all on function chalito_private.notify_from_session_event(), chalito_private.notify_from_approval()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- the app's calm actions
create or replace function chalito_private.notification_action(p_action text, p_sid text, p_nid text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := chalito.jwt_owner();
  v_bucket bigint := floor(extract(epoch from now()))::bigint;
  v_id text := coalesce(p_sid, p_nid);
begin
  if v_owner is null or not chalito_private.active_client() then
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  if p_action not in ('seen', 'waiting', 'not_waiting', 'snooze')
     or (p_action = 'snooze') <> (p_nid is not null and p_sid is null)
     or v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'chalito: bad notification action' using errcode = '22023';
  end if;
  -- Park and undo are deliberate clicks, each delivered; seen and snooze repeats within a second are one.
  perform chalito_private.notify_enqueue(v_owner, p_action || ':' || v_owner || ':' || v_id || ':'
      || case when p_action in ('waiting', 'not_waiting') then gen_random_uuid()::text else v_bucket::text end,
    case p_action
      when 'seen' then jsonb_build_object('v', 1, 'type', 'seen', 'uid', v_owner, 'sid', p_sid)
      when 'waiting' then jsonb_build_object('v', 1, 'type', 'waiting', 'uid', v_owner, 'sid', p_sid, 'on', true)
      when 'not_waiting' then jsonb_build_object('v', 1, 'type', 'waiting', 'uid', v_owner, 'sid', p_sid, 'on', false)
      else jsonb_build_object('v', 1, 'type', 'snooze_alert', 'uid', v_owner, 'nid', p_nid)
    end);
end
$$;

create or replace function chalito.notification_action(p_action text, p_sid text default null, p_nid text default null)
returns void language sql volatile security invoker set search_path = ''
as $$ select chalito_private.notification_action(p_action, p_sid, p_nid) $$;

revoke all on function chalito_private.notification_action(text, text, text), chalito.notification_action(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.notification_action(text, text, text), chalito.notification_action(text, text, text)
  to authenticated;
