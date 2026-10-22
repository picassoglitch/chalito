-- "Your agent finished" push. A coding session's turn ends when the agent writes a session.state
-- event of `idle` or `completed`; that now queues a `turn_finished` notification (L1, one push, no
-- WhatsApp/call/SMS) through the same outbox as approvals and questions, so quiet hours, the
-- desktop-active hold and dedupe apply. Only turns that ran 60 s to 30 min notify: a quick reply
-- isn't news, and a longer one is most likely a turn the agent lost in a restart (no end event is
-- written). At most one per session every 10 min, and the owner's next prompt in that session acks
-- (cancels) a push still waiting.
--
-- Deploy order: the notifier image first, then this migration (an older notifier would not know the
-- `turn_finished` source). A `completed` after an `idle` with no new turn in between finds no turn start and
-- stays silent. The link is the same "/s/<sid>" the question notification uses.

create or replace function chalito_private.notify_from_session_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_end integer;
  v_start timestamptz;
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
    -- The turn started at the first `running` after the previous turn's end. Ordered by seq (monotonic
    -- per session): an idle and the next running can share the same millisecond.
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
  elsif new.type = 'message.user' then
    -- The owner prompted again: they are here, so a waiting "finished" push is stale.
    perform chalito_private.notify_enqueue(new.owner, 'turn_ack:' || new.owner || ':' || new.sid || ':' || new.eid,
      jsonb_build_object('v', 1, 'type', 'ack', 'uid', new.owner, 'via', 'app', 'coalesceKey', left('turn:' || new.sid, 128)));
  end if;
  return null;
end
$$;

revoke all on function chalito_private.notify_from_session_event() from public, anon, authenticated, service_role;
