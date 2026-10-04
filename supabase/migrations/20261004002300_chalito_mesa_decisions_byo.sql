-- M9 part 2: Mesa decisions and BYO brain keys.
--
-- 1. A Mesa participant can ASK for a decision: the orchestrator (chalito_server) creates a pending
--    `kind=decision` approval, device 'orchestrator', details sealed to the person's clients. It
--    can't create anything else and has no status grant. The person answers with the normal signed
--    Decision (approval_decisions, client RLS). A decision binds only after its Ed25519 signature
--    is verified: the orchestrator verifies it with @chalito/crypto against the signer's stored
--    pub_sign, then calls chalito_private.resolve_orchestrator_decision, which re-checks the rows
--    in SQL and can only ever touch pending orchestrator decisions (never an agent's approval).
-- 2. BYO brain keys: a copy sealed to the person's own devices (readable by them under RLS) and,
--    only if they opt in to cloud turns, a KMS-wrapped copy in chalito_private that only the
--    orchestrator reads. Neither is ever readable by the MCP gateway.

-- ---------------------------------------------------------------- 1. decisions
grant insert (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
  on chalito.approvals to chalito_server;
-- Restrictive: on top of server_all, the server may only create pending Mesa decisions.
create policy server_creates_mesa_decisions_only on chalito.approvals as restrictive for insert to chalito_server
  with check (kind = 'decision' and status = 'pending' and device_id = 'orchestrator'
              and recommendations = '[]'::jsonb and not step_up_required and risk in ('LOW', 'MED'));

-- Called by the orchestrator only AFTER it verified the decision's signature. Returns the new
-- status, or null when nothing was resolved (not a pending orchestrator decision, expired, no
-- such signed row, signer not an active client of the owner, or a malformed body).
create or replace function chalito_private.resolve_orchestrator_decision(p_owner text, p_aid text, p_signer text)
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
  where ad.owner = p_owner and ad.aid = p_aid and ad.signer_device_id = p_signer
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
revoke all on function chalito_private.resolve_orchestrator_decision(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function chalito_private.resolve_orchestrator_decision(text, text, text) to chalito_server;

-- ---------------------------------------------------------------- 2. BYO brain keys
create table chalito.brain_keys (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'xai', 'google')),
  -- The key sealed to the person's own devices (aad brainkey:<owner>:<provider>).
  sealed_ct jsonb not null check (jsonb_typeof(sealed_ct) = 'object' and octet_length(sealed_ct::text) <= 8192),
  hint text not null check (char_length(hint) <= 8),
  cloud boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner, provider)
);
create table chalito_private.brain_key_wrapped (
  owner chalito.id not null,
  provider text not null,
  wrapped text not null check (char_length(wrapped) <= 8192),
  created_at timestamptz not null default now(),
  primary key (owner, provider),
  foreign key (owner, provider) references chalito.brain_keys (owner, provider) on delete cascade
);
-- cloud = true exactly when a wrapped copy exists (kept in step by the orchestrator, checked here).
create or replace function chalito_private.brain_key_cloud_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.cloud then
    delete from chalito_private.brain_key_wrapped w where w.owner = new.owner and w.provider = new.provider;
  end if;
  return null;
end
$$;
revoke execute on function chalito_private.brain_key_cloud_check() from public;
create trigger brain_keys_cloud_off after insert or update on chalito.brain_keys
  for each row execute function chalito_private.brain_key_cloud_check();

alter table chalito.brain_keys enable row level security;
alter table chalito_private.brain_key_wrapped enable row level security;
create policy brain_keys_read on chalito.brain_keys for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.active_client()));
create policy server_all on chalito.brain_keys for all to chalito_server using (true) with check (true);
create policy server_all on chalito_private.brain_key_wrapped for all to chalito_server using (true) with check (true);
revoke all on chalito.brain_keys, chalito_private.brain_key_wrapped from public, anon, authenticated, service_role;
grant select on chalito.brain_keys to authenticated;
grant select, insert, update, delete on chalito.brain_keys, chalito_private.brain_key_wrapped to chalito_server;
