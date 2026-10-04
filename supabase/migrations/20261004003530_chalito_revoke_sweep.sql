-- What a revoke must also end (the rehearsal-driven sweep of per-device rows). The 003520 trigger
-- already drops a revoked device's push subscriptions and call lines; now also:
--  1. its pending approvals are denied (reason agent_revoked) through a normal status update, so
--     the notify-outbox trigger queues the ack and the escalation ladder stops;
--  2. its plaintext session cards (session_card_plain) are deleted: nothing it shared stays shared;
--  5. a client device holding room keys marks those rooms for rotation (a revoked device may be a
--     stolen one: the epoch key it may hold in memory must stop being useful). Posts are refused
--     until a remaining member rotates, as after a leave; its own sealed key rows go too.
-- Runs as the definer, so approvals_guard (which only restricts `authenticated`) lets it through.

create or replace function chalito_private.drop_revoked_device_reach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.push_subscriptions p where p.owner = new.owner and p.device_id = new.device_id;
  delete from chalito.call_lines cl where cl.owner = new.owner and cl.device_id = new.device_id;
  update chalito.approvals a
     set status = 'denied', reason = 'agent_revoked', resolved_at = now()
   where a.owner = new.owner and a.device_id = new.device_id and a.status = 'pending';
  delete from chalito.session_card_plain c where c.owner = new.owner and c.device_id = new.device_id;
  if new.role = 'client' then
    update chalito.rooms r set needs_rotation = true
     where r.room_id in (select k.room_id from chalito.room_member_keys k
                         where k.uid = new.owner and k.device_id = new.device_id);
    delete from chalito.room_member_keys k where k.uid = new.owner and k.device_id = new.device_id;
  end if;
  return null;
end
$$;
revoke all on function chalito_private.drop_revoked_device_reach() from public, anon, authenticated, service_role;
