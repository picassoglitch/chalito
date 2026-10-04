-- Approval decisions: several attempts per device, still insert-only (S6).
--
-- The primary key was (owner, aid, signer_device_id): one row per device per approval. A rejected
-- row (an allow without the passkey step-up, a client bug, a forged row written with the
-- device's session) then blocked that device's valid decision until the approval expired. Now
-- each attempt is its own row (an id in the key), up to 5 per device per approval. Rows are
-- still never updated or deleted by clients (no such grants or policies), so a valid decision
-- can't be overwritten. Agents and the orchestrator evaluate rows in insertion order; the first
-- valid signed decision wins and invalid ones are audited once, as before.

alter table chalito.approval_decisions add column id uuid not null default gen_random_uuid();
alter table chalito.approval_decisions drop constraint approval_decisions_pkey;
alter table chalito.approval_decisions add primary key (owner, aid, signer_device_id, id);

-- At most 5 attempts per device per approval (the per-device rate bucket still applies on top).
-- Serialized per (owner, aid, signer) so concurrent inserts can't slip past the cap.
create or replace function chalito_private.decision_attempt_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('chalito.decision:' || new.owner || '/' || new.aid || '/' || new.signer_device_id));
  if (select count(*) from chalito.approval_decisions d
      where d.owner = new.owner and d.aid = new.aid and d.signer_device_id = new.signer_device_id) >= 5 then
    raise exception 'too many decision attempts for this approval from this device'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke all on function chalito_private.decision_attempt_cap() from public, anon, authenticated, service_role;

create trigger approval_decisions_attempt_cap before insert on chalito.approval_decisions
  for each row execute function chalito_private.decision_attempt_cap();

-- The pointer names the row (agents read every row of the approval anyway).
create or replace function chalito_private.broadcast_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  key jsonb;
  target text;
begin
  key := case tg_table_name
    when 'commands' then jsonb_build_object('target_device_id', r -> 'target_device_id', 'id', r -> 'id')
    when 'sessions' then jsonb_build_object('sid', r -> 'sid')
    when 'session_events' then jsonb_build_object('sid', r -> 'sid', 'eid', r -> 'eid')
    when 'approvals' then jsonb_build_object('aid', r -> 'aid')
    when 'approval_decisions' then
      jsonb_build_object('aid', r -> 'aid', 'signer_device_id', r -> 'signer_device_id', 'id', r -> 'id')
    when 'notifications' then jsonb_build_object('nid', r -> 'nid')
    when 'devices' then jsonb_build_object('device_id', r -> 'device_id')
    else '{}'::jsonb
  end;
  target := case tg_argv[0]
    when 'target' then r ->> 'target_device_id'
    when 'approval_agent' then (select a.device_id from chalito.approvals a
                                where a.owner = r ->> 'owner' and a.aid = r ->> 'aid')
  end;
  if tg_argv[0] in ('target', 'approval_agent') and target is null then
    return null;
  end if;
  perform chalito_private.send_to_devices(
    r ->> 'owner',
    tg_table_name,
    jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'key', key, 'rev', r -> 'rev'),
    target,
    case when tg_argv[0] = 'clients' then 'client' end
  );
  return null;
end
$$;

-- The orchestrator resolves with exactly the row it verified (by id), not "the signer's row".
drop function chalito_private.resolve_orchestrator_decision(text, text, text);
create function chalito_private.resolve_orchestrator_decision(p_owner text, p_aid text, p_signer text, p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb;
  s text;
begin
  select ad.decision into d
  from chalito.approval_decisions ad
  join chalito.devices dv on dv.owner = ad.owner and dv.device_id = ad.signer_device_id
  where ad.owner = p_owner and ad.aid = p_aid and ad.signer_device_id = p_signer and ad.id = p_id
    and dv.role = 'client' and not dv.revoked;
  if d is null
     or d ->> 'ctx' is distinct from 'chalito.decision.v1'
     or d ->> 'signerDeviceId' is distinct from p_signer
     or d #>> '{body,aid}' is distinct from p_aid
     or d #>> '{body,uid}' is distinct from p_owner
     or d #>> '{body,targetDeviceId}' is distinct from 'orchestrator'
     or jsonb_typeof(d #> '{body,allow}') is distinct from 'boolean' then
    return null;
  end if;
  s := case when (d #>> '{body,allow}')::boolean then 'approved' else 'denied' end;
  update chalito.approvals a
     set status = s,
         reason = 'signed:' || p_signer || coalesce(':choice=' || (d #>> '{body,choice}'), ''),
         resolved_at = now()
   where a.owner = p_owner and a.aid = p_aid
     and a.kind = 'decision' and a.device_id = 'orchestrator'
     and a.status = 'pending' and a.expires_at > now()
     and a.request_id = d #>> '{body,requestId}';
  if not found then
    return null;
  end if;
  return s;
end
$$;
revoke all on function chalito_private.resolve_orchestrator_decision(text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.resolve_orchestrator_decision(text, text, text, uuid) to chalito_server;
