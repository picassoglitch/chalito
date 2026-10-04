-- A revoked device gets no more notifications (found by the beta rehearsal: after a phone was
-- revoked mid-approval, the escalation ladder kept pushing to it).
--
-- One place for every revoke path (revokeDevice, revokeOtherClients and so revoke-all, and any
-- SQL-side revoke): when a device turns revoked, its web push subscriptions and its call lines
-- (what a call reads out for that agent's sessions) are deleted. Account deletion was already
-- covered (users → devices → both, by cascade). The notifier also reads only active devices'
-- subscriptions, call lines and approvals (defence in depth).

create or replace function chalito_private.drop_revoked_device_reach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.push_subscriptions p where p.owner = new.owner and p.device_id = new.device_id;
  delete from chalito.call_lines cl where cl.owner = new.owner and cl.device_id = new.device_id;
  return null;
end
$$;
revoke all on function chalito_private.drop_revoked_device_reach() from public, anon, authenticated, service_role;

create trigger devices_revoked_drop_push after update of revoked on chalito.devices
  for each row when (new.revoked and not old.revoked)
  execute function chalito_private.drop_revoked_device_reach();
