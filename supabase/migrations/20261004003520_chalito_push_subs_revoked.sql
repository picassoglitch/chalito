-- A revoked device gets no more notifications (found by the beta rehearsal: after a phone was
-- revoked mid-approval, the escalation ladder kept pushing to it).
--
-- One place for every revoke path (revokeDevice, revokeOtherClients and so revoke-all, and any
-- SQL-side revoke): when a device turns revoked, its web push subscriptions are deleted. Account
-- deletion was already covered (users → devices → push_subscriptions cascade). The notifier also
-- reads only active devices' subscriptions (defence in depth).

create or replace function chalito_private.drop_revoked_push_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chalito.push_subscriptions p where p.owner = new.owner and p.device_id = new.device_id;
  return null;
end
$$;
revoke all on function chalito_private.drop_revoked_push_subscriptions() from public, anon, authenticated, service_role;

create trigger devices_revoked_drop_push after update of revoked on chalito.devices
  for each row when (new.revoked and not old.revoked)
  execute function chalito_private.drop_revoked_push_subscriptions();
