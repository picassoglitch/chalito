-- ADR 0018: when a new client is endorsed (/v1/devices/endorsed stores the endorsement), tell the
-- account's agents so they can vet it against their local trusted list right away (they also
-- re-read endorsements on resync and every 15 minutes). Pointer only: the agent reads the row
-- under RLS (endorsements_read) and trusts nothing it can't verify itself.
create or replace function chalito_private.broadcast_endorsement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform chalito_private.send_to_devices(
    new.owner,
    'endorsements',
    jsonb_build_object('table', 'endorsements', 'op', 'insert', 'key', jsonb_build_object('device_id', new.device_id)),
    null,
    'agent');
  return null;
end
$$;
revoke execute on function chalito_private.broadcast_endorsement() from public, anon, authenticated, service_role;

create trigger endorsements_broadcast after insert on chalito.endorsements
  for each row execute function chalito_private.broadcast_endorsement();
