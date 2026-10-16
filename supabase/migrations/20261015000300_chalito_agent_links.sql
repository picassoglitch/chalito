-- Agent-to-agent links (ADR 0022 §3), part 2: the phone's view of each device's links, and
-- revoke-all reaching them (ADR 0020).
--
-- chalito.agent_links is a MIRROR. The agent writes what it holds locally (a signed file on the
-- device is the only source of a link), so a row here never grants anything. Plaintext columns
-- are metadata only (ids, mode, confirm, ceiling, expiry, revocation); the goal, the workspace
-- label, the budget and the endpoints' sessions are sealed to the person's clients (details_ct).
--
-- Writes:
--  * the agent, only through chalito.publish_agent_links (its own rows; a row it no longer holds
--    is marked revoked; a revoked row is never un-revoked);
--  * the api (chalito_server), only through chalito_private.revoke_agent_links, which
--    "Cerrar sesión en todos los demás dispositivos" calls. Each agent checks this mark before
--    every delivery and drops the link (fail closed), so a revoke-all reaches links even on a
--    computer that gets no revokeClient command (no other clients to revoke).
-- Reads: the owner's devices (RLS).

create table chalito.agent_links (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  device_id chalito.id not null,
  link_id text not null check (link_id ~ '^lnk_[A-Za-z0-9_-]{8,64}$'),
  mode text not null check (mode in ('share', 'handoff')),
  sender_device_id chalito.id not null,
  receiver_device_id chalito.id not null,
  confirm boolean not null,
  permission_ceiling text not null check (permission_ceiling in ('default', 'plan', 'acceptEdits')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text check (revoked_by is null or length(revoked_by) <= 64),
  details_ct jsonb not null check (jsonb_typeof(details_ct) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner, device_id, link_id),
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade,
  -- One end of every link is the device that holds it.
  check (device_id in (sender_device_id, receiver_device_id))
);
create index agent_links_owner_idx on chalito.agent_links (owner);

alter table chalito.agent_links enable row level security;
create policy agent_links_read on chalito.agent_links for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.device_ok()));
revoke all on chalito.agent_links from public, anon, authenticated;
grant select on chalito.agent_links to authenticated;

-- The agent's own rows, replaced by what it holds now (at most 200 links per device).
create or replace function chalito.publish_agent_links(p_links jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text := chalito.jwt_owner();
  v_device text := chalito.jwt_device_id();
  v_ids text[];
  l jsonb;
begin
  if not chalito_private.active_agent() then
    raise exception 'only an active agent publishes its links' using errcode = '42501';
  end if;
  if jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 200 then
    raise exception 'links must be an array of at most 200' using errcode = '22023';
  end if;
  select coalesce(array_agg(e ->> 'link_id'), '{}') into v_ids from jsonb_array_elements(p_links) e;

  -- Links it no longer holds were revoked (or expired) on the device.
  update chalito.agent_links a
     set revoked_at = now(), revoked_by = 'agent', updated_at = now()
   where a.owner = v_owner and a.device_id = v_device and a.revoked_at is null
     and not (a.link_id = any (v_ids));

  for l in select * from jsonb_array_elements(p_links) loop
    insert into chalito.agent_links as a (owner, device_id, link_id, mode, sender_device_id, receiver_device_id,
                                          confirm, permission_ceiling, expires_at, revoked_at, revoked_by,
                                          details_ct, updated_at)
    values (v_owner, v_device, l ->> 'link_id', l ->> 'mode', l ->> 'sender_device_id', l ->> 'receiver_device_id',
            (l ->> 'confirm')::boolean, l ->> 'permission_ceiling', (l ->> 'expires_at')::timestamptz,
            (l ->> 'revoked_at')::timestamptz, case when l ->> 'revoked_at' is null then null else 'agent' end,
            l -> 'details_ct', now())
    on conflict (owner, device_id, link_id) do update
      set mode = excluded.mode,
          sender_device_id = excluded.sender_device_id,
          receiver_device_id = excluded.receiver_device_id,
          confirm = excluded.confirm,
          permission_ceiling = excluded.permission_ceiling,
          expires_at = excluded.expires_at,
          -- Never un-revoke: a revoke-all mark stays, whatever the agent sends.
          revoked_at = coalesce(a.revoked_at, excluded.revoked_at),
          revoked_by = coalesce(a.revoked_by, excluded.revoked_by),
          details_ct = excluded.details_ct,
          updated_at = now();
  end loop;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;
revoke all on function chalito.publish_agent_links(jsonb) from public, anon;
grant execute on function chalito.publish_agent_links(jsonb) to authenticated;

-- Revoke-all (api, as chalito_server): every link of the account.
create or replace function chalito_private.revoke_agent_links(p_owner text, p_by text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update chalito.agent_links
     set revoked_at = now(), revoked_by = left(coalesce(p_by, 'revoke_all'), 64), updated_at = now()
   where owner = p_owner and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function chalito_private.revoke_agent_links(text, text) from public, anon, authenticated;
grant execute on function chalito_private.revoke_agent_links(text, text) to chalito_server;
