-- Security review fixes (docs/reviews/supabase-review.md on origin/supa, S1–S9) and the owner's
-- token decision: devices are Supabase Auth users of the hub project, with Chalito claims in
-- app_metadata.chalito (Option C). ADR 0017 §Security review fixes.

-- ================================================================ S1/S3/S5: identity
-- Device and pairing tokens are Supabase Auth users per device: sub = that auth user's id (never
-- the hub uid), app_metadata.chalito = {owner, device_id, role, pairing_code?} set by the API only.
-- A person's web session is their real hub account: no app_metadata.chalito, sub = hub uid → 'user'.
-- 'custom' (Chalito-minted JWTs) stays behind the switch: iss = claim_issuer(), and sub is namespaced
-- (d_<device>, u_<owner>, p_<code>) so it never equals a hub uid.
create or replace function chalito_private.claim_source()
returns text language sql immutable set search_path = ''
as $$ select 'app_metadata' $$;

create or replace function chalito_private.claim_issuer()
returns text language sql immutable set search_path = ''
as $$ select 'chalito' $$;
comment on function chalito_private.claim_issuer() is
  'Expected iss for custom-mode tokens (a URL for a third-party issuer). ADR 0017.';

create or replace function chalito.jwt_claims()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    -- Every Chalito principal is an `authenticated`-audience token.
    when not (coalesce(j -> 'aud', 'null') = '"authenticated"'
              or (jsonb_typeof(j -> 'aud') = 'array' and j -> 'aud' ? 'authenticated')) then null
    when chalito_private.claim_source() = 'app_metadata' then
      case
        when jsonb_typeof(j -> 'app_metadata' -> 'chalito') = 'object' then jsonb_build_object(
          'sub', j ->> 'sub',
          'owner', j -> 'app_metadata' -> 'chalito' ->> 'owner',
          'device_id', j -> 'app_metadata' -> 'chalito' ->> 'device_id',
          'chalito_role', j -> 'app_metadata' -> 'chalito' ->> 'role',
          'pairing_code', j -> 'app_metadata' -> 'chalito' ->> 'pairing_code')
        -- A hub account (not anonymous, not a Chalito device user) is that person's web session.
        when nullif(j ->> 'sub', '') is not null and coalesce(j ->> 'is_anonymous', 'false') <> 'true'
             and not (j -> 'app_metadata' ? 'chalito') then
          jsonb_build_object('sub', j ->> 'sub', 'owner', j ->> 'sub', 'chalito_role', 'user')
      end
    when chalito_private.claim_source() = 'custom' and j ->> 'iss' = chalito_private.claim_issuer() then
      case
        when j ->> 'chalito_role' in ('client', 'agent') and j ->> 'sub' = 'd_' || (j ->> 'device_id') then j
        when j ->> 'chalito_role' = 'user' and j ->> 'sub' = 'u_' || (j ->> 'owner') then j
        when j ->> 'chalito_role' = 'pairing' and j ->> 'sub' = 'p_' || (j ->> 'pairing_code') then j
      end
  end
  from (select auth.jwt() as j) as s
$$;

-- The device's own auth user (app_metadata mode). Set by the API at enrolment.
alter table chalito.devices add column auth_user_id uuid unique;
-- The pairing watcher's auth user (app_metadata mode). Set by the API when it issues the watch token.
alter table chalito.pairing_codes add column watch_auth_user_id uuid;

create or replace function chalito_private.device_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from chalito.devices d
    where d.device_id = chalito.jwt_device_id()
      and d.owner = chalito.jwt_owner()
      and d.role = chalito.jwt_role()
      and not d.revoked
      -- app_metadata mode: the token must be this device's own auth user (S5).
      and (chalito_private.claim_source() = 'custom'
           or d.auth_user_id::text = chalito.jwt_claims() ->> 'sub')
  )
$$;

create or replace function chalito_private.pairing_watch_ok(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select chalito.jwt_role() = 'pairing'
     and p_code = chalito.jwt_pairing_code()
     and exists (select 1 from chalito.pairing_codes c
                 where c.code_id = p_code and c.expires_at > now()
                   and (chalito_private.claim_source() = 'custom'
                        or c.watch_auth_user_id::text = chalito.jwt_claims() ->> 'sub'))
$$;

drop policy pairing_codes_watch on chalito.pairing_codes;
create policy pairing_codes_watch on chalito.pairing_codes for select to authenticated
  using (code_id = (select chalito.jwt_pairing_code())
         and (select chalito_private.pairing_watch_ok(chalito.jwt_pairing_code())));

-- ================================================================ S6: insert-only decisions
-- One row per signer per approval; nothing is ever overwritten. The agent reads every row for
-- the aid and acts on the first one whose signature verifies against its local trusted list.
create table chalito.approval_decisions (
  owner chalito.id not null,
  aid chalito.id not null,
  signer_device_id chalito.id not null,
  decision jsonb not null check (jsonb_typeof(decision) = 'object' and octet_length(decision::text) <= 16384),
  created_at timestamptz not null default now(),
  rev bigint not null,
  primary key (owner, aid, signer_device_id),
  foreign key (owner, aid) references chalito.approvals (owner, aid) on delete cascade
);
create index approval_decisions_owner_rev_idx on chalito.approval_decisions (owner, rev);
alter table chalito.approval_decisions enable row level security;
create trigger bump_rev before insert or update on chalito.approval_decisions
  for each row execute function chalito_private.bump_rev();

create policy approval_decisions_read on chalito.approval_decisions for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.member_ok()));

create policy approval_decisions_client_create on chalito.approval_decisions for insert to authenticated
  with check (
    owner = (select chalito.jwt_owner())
    and signer_device_id = (select chalito.jwt_device_id())
    and (select chalito_private.active_client())
    and exists (select 1 from chalito.approvals a
                where a.owner = approval_decisions.owner and a.aid = approval_decisions.aid
                  and a.status = 'pending' and a.expires_at > now())
  );

-- The overwritable field goes; clients no longer update approvals at all.
drop policy approvals_update on chalito.approvals;
create policy approvals_agent_update on chalito.approvals for update to authenticated
  using (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
         and (select chalito_private.active_agent()))
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id()));

create or replace function chalito_private.approvals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if chalito.jwt_role() = 'agent' then
    perform chalito_private.assert_only_changes(to_jsonb(old), to_jsonb(new), array['status', 'reason', 'resolved_at', 'rev']);
  else
    raise exception 'chalito: not allowed' using errcode = '42501';
  end if;
  return new;
end
$$;
alter table chalito.approvals drop column decision;

-- ================================================================ S4: namespaced topics, restrictive guard
create or replace function chalito_private.send_to_devices(
  p_owner text, p_event text, p_payload jsonb, p_device_id text default null, p_role text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
begin
  for d in
    select device_id from chalito.devices
    where owner = p_owner and not revoked
      and (p_device_id is null or device_id = p_device_id)
      and (p_role is null or role = p_role)
  loop
    perform realtime.send(p_payload, p_event, 'chalito:device:' || d.device_id, true);
  end loop;
end
$$;

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
    when 'approval_decisions' then jsonb_build_object('aid', r -> 'aid', 'signer_device_id', r -> 'signer_device_id')
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

create trigger approval_decisions_broadcast after insert on chalito.approval_decisions
  for each row execute function chalito_private.broadcast_change('approval_agent');

create or replace function chalito_private.broadcast_pairing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('table', 'pairing_codes', 'op', lower(tg_op),
                       'key', jsonb_build_object('code_id', new.code_id), 'rev', new.rev),
    'pairing_codes', 'chalito:pairing:' || new.code_id, true);
  return null;
end
$$;

-- May the caller use this Chalito topic? Own device topic while active, or own live pairing code.
create or replace function chalito_private.realtime_topic_ok(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic = 'chalito:device:' || chalito.jwt_device_id() then chalito_private.device_ok()
    when p_topic = 'chalito:pairing:' || chalito.jwt_pairing_code() then chalito_private.pairing_watch_ok(chalito.jwt_pairing_code())
    else false
  end
$$;

drop policy chalito_device_topic_read on realtime.messages;
drop policy chalito_pairing_topic_read on realtime.messages;

create policy chalito_topics_read on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast'
         and (select chalito_private.realtime_topic_ok(realtime.topic())));

-- RESTRICTIVE, for every role and command: whatever permissive policies the hub has or adds on
-- realtime.messages, a chalito:* topic is readable only through realtime_topic_ok() and never
-- writable by a client. Other topics pass through untouched.
create policy chalito_topics_guard on realtime.messages as restrictive for all to public
  using (
    not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%')
    or (realtime.messages.topic = (select realtime.topic())
        and (select chalito_private.realtime_topic_ok(realtime.topic())))
  )
  with check (
    not (coalesce((select realtime.topic()), '') like 'chalito:%' or realtime.messages.topic like 'chalito:%')
  );

-- ================================================================ S7: rate buckets, coalesced events
create table chalito_private.rate_limits (
  tbl text primary key,
  capacity integer not null check (capacity > 0),
  per_second numeric not null check (per_second > 0)
);
insert into chalito_private.rate_limits (tbl, capacity, per_second) values
  ('commands', 30, 1),
  ('sessions', 30, 1),
  ('session_events', 120, 20),
  ('approvals', 30, 2),
  ('approval_decisions', 30, 2),
  ('call_lines', 20, 1),
  ('audit', 60, 5);

create table chalito_private.rate_buckets (
  device_id chalito.id not null,
  tbl text not null,
  tokens numeric not null,
  updated_at timestamptz not null,
  primary key (device_id, tbl)
);

-- A token bucket per device per table, for client inserts only (the server is not limited here).
-- The role GUC is what SET ROLE / PostgREST set; it is unchanged inside a security-definer body.
create or replace function chalito_private.rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim record;
  dev text := chalito.jwt_device_id();
  left_ numeric;
begin
  if coalesce(current_setting('role', true), '') <> 'authenticated' or dev is null then
    return new;
  end if;
  select capacity, per_second into lim from chalito_private.rate_limits where tbl = tg_table_name;
  if not found then
    return new;
  end if;
  insert into chalito_private.rate_buckets as b (device_id, tbl, tokens, updated_at)
  values (dev, tg_table_name, lim.capacity - 1, clock_timestamp())
  on conflict (device_id, tbl) do update
    set tokens = least(lim.capacity::numeric,
                       b.tokens + extract(epoch from clock_timestamp() - b.updated_at) * lim.per_second) - 1,
        updated_at = clock_timestamp()
  returning tokens into left_;
  if left_ < 0 then
    -- PostgREST maps SQLSTATE PTxyz to HTTP status xyz.
    raise exception 'chalito: rate limit for % on %', dev, tg_table_name using errcode = 'PT429';
  end if;
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['commands', 'sessions', 'session_events', 'approvals', 'approval_decisions',
                           'call_lines', 'audit']
  loop
    execute format('create trigger rate_limit before insert on chalito.%I
                    for each row execute function chalito_private.rate_limit()', t);
  end loop;
end
$$;

-- At most N session_events pointers per second per session; the rest mark the session dirty and a
-- pg_cron flush sends one coalesced pointer (the newest rev covers everything before it).
create or replace function chalito_private.event_broadcasts_per_second()
returns integer language sql immutable set search_path = '' as $$ select 10 $$;

create table chalito_private.event_gates (
  owner chalito.id not null,
  sid chalito.id not null,
  window_start timestamptz not null,
  sent integer not null,
  dirty boolean not null default false,
  primary key (owner, sid)
);

create or replace function chalito_private.broadcast_session_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w timestamptz := date_trunc('second', clock_timestamp());
  n integer;
begin
  insert into chalito_private.event_gates as g (owner, sid, window_start, sent)
  values (new.owner, new.sid, w, 1)
  on conflict (owner, sid) do update
    set sent = case when g.window_start = w then g.sent + 1 else 1 end,
        window_start = w
  returning sent into n;
  if n > chalito_private.event_broadcasts_per_second() then
    update chalito_private.event_gates set dirty = true where owner = new.owner and sid = new.sid;
    return null;
  end if;
  update chalito_private.event_gates set dirty = false where owner = new.owner and sid = new.sid;
  perform chalito_private.send_to_devices(
    new.owner, 'session_events',
    jsonb_build_object('table', 'session_events', 'op', 'insert',
                       'key', jsonb_build_object('sid', new.sid, 'eid', new.eid), 'rev', new.rev),
    null, 'client');
  return null;
end
$$;

drop trigger session_events_broadcast on chalito.session_events;
create trigger session_events_broadcast after insert on chalito.session_events
  for each row execute function chalito_private.broadcast_session_event();

create or replace function chalito_private.flush_coalesced_events()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
begin
  for g in
    select e.owner, e.sid from chalito_private.event_gates e
    where e.dirty and e.window_start < clock_timestamp() - interval '1 second'
    for update skip locked
  loop
    perform chalito_private.send_to_devices(
      g.owner, 'session_events',
      jsonb_build_object('table', 'session_events', 'op', 'coalesced',
                         'key', jsonb_build_object('sid', g.sid),
                         'rev', (select max(rev) from chalito.session_events s where s.owner = g.owner and s.sid = g.sid)),
      null, 'client');
    update chalito_private.event_gates set dirty = false where owner = g.owner and sid = g.sid;
  end loop;
end
$$;

select cron.schedule('chalito-flush-coalesced', '* * * * *', 'select chalito_private.flush_coalesced_events()');

-- ================================================================ S8: sid must be the writer's session
drop policy session_events_agent_create on chalito.session_events;
create policy session_events_agent_create on chalito.session_events for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent())
              and exists (select 1 from chalito.sessions s where s.owner = session_events.owner
                            and s.sid = session_events.sid and s.device_id = (select chalito.jwt_device_id())));

drop policy approvals_agent_create on chalito.approvals;
create policy approvals_agent_create on chalito.approvals for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent()) and status = 'pending'
              and exists (select 1 from chalito.sessions s where s.owner = approvals.owner
                            and s.sid = approvals.sid and s.device_id = (select chalito.jwt_device_id())));

drop policy call_lines_agent_create on chalito.call_lines;
create policy call_lines_agent_create on chalito.call_lines for insert to authenticated
  with check (owner = (select chalito.jwt_owner()) and device_id = (select chalito.jwt_device_id())
              and (select chalito_private.active_agent())
              and exists (select 1 from chalito.sessions s where s.owner = call_lines.owner
                            and s.sid = call_lines.sid and s.device_id = (select chalito.jwt_device_id())));

-- ================================================================ S9: clamp client-set times
create or replace function chalito_private.clamp_client_times()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  case tg_table_name
    when 'commands' then
      new.expires_at := least(coalesce(new.expires_at, now() + interval '10 minutes'), now() + interval '10 minutes');
    when 'call_lines' then
      new.expires_at := least(new.expires_at, now() + interval '30 minutes');
    when 'session_events' then
      new.expires_at := least(coalesce(new.expires_at, now() + interval '7 days'), now() + interval '7 days');
    when 'approvals' then
      new.created_at := now();
      new.expires_at := least(new.expires_at, now() + interval '10 minutes');
    else
      null;
  end case;
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['commands', 'call_lines', 'session_events', 'approvals']
  loop
    execute format('create trigger clamp_client_times before insert on chalito.%I
                    for each row execute function chalito_private.clamp_client_times()', t);
  end loop;
end
$$;

-- ================================================================ S2: privileges
-- The hub's service_role (held by every hub engine) gets nothing in Chalito's schemas. Chalito's
-- server (api, notifier, gateway) uses its own role. NOLOGIN here: deploy creates a login member.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chalito_server') then
    create role chalito_server nologin nobypassrls;
  end if;
end
$$;
-- Lets migrations and tests act as the server (`set role chalito_server`) without inheriting it.
grant chalito_server to postgres with inherit false, set true;

revoke all on all tables in schema chalito, chalito_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema chalito, chalito_private from public, anon, authenticated, service_role;
revoke all on all functions in schema chalito, chalito_private from public, anon, authenticated, service_role;
revoke all on schema chalito, chalito_private from public, anon, service_role;

grant usage on schema chalito, chalito_private to authenticated, chalito_server;

-- ---------------------------------------------------------------- authenticated (devices, web)
grant execute on function chalito.jwt_claims(), chalito.jwt_owner(), chalito.jwt_device_id(), chalito.jwt_role(),
  chalito.jwt_pairing_code(), chalito_private.claim_source(), chalito_private.claim_issuer(),
  chalito_private.device_ok(), chalito_private.member_ok(), chalito_private.active_client(),
  chalito_private.active_agent(), chalito_private.pairing_watch_ok(text), chalito_private.realtime_topic_ok(text),
  chalito_private.assert_only_changes(jsonb, jsonb, text[]) to authenticated;
grant execute on function chalito.session_merge(text, jsonb) to authenticated;

grant select on chalito.users, chalito.devices, chalito.endorsements, chalito.pairing_codes, chalito.commands,
  chalito.sessions, chalito.session_events, chalito.approvals, chalito.approval_decisions, chalito.notifications,
  chalito.audit, chalito.companions, chalito.inventory to authenticated;
grant update (last_seen_at, policy_hash, dev_mode, status, presence, last_event) on chalito.devices to authenticated;
grant insert (owner, target_device_id, id, env, from_device_id, expires_at) on chalito.commands to authenticated;
grant delete on chalito.commands to authenticated;
grant insert (owner, sid, device_id, doc) on chalito.sessions to authenticated;
grant update (doc) on chalito.sessions to authenticated;
grant insert (owner, sid, eid, device_id, seq, t, type, urgency, doc, expires_at) on chalito.session_events to authenticated;
grant insert (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, status,
  expires_at, recommendations) on chalito.approvals to authenticated;
grant update (status, reason, resolved_at) on chalito.approvals to authenticated;
grant insert (owner, aid, signer_device_id, decision) on chalito.approval_decisions to authenticated;
grant update (state, acked_at, acked_via) on chalito.notifications to authenticated;
grant select (owner, lid, device_id, expires_at) on chalito.call_lines to authenticated;
grant insert (owner, lid, notification_id, device_id, sid, line, expires_at) on chalito.call_lines to authenticated;
grant delete on chalito.call_lines to authenticated;
grant insert (owner, device_id, eid, t, type, meta, source) on chalito.audit to authenticated;
grant update (name, is_renamed, persona, voice, style, render_quality) on chalito.companions to authenticated;

-- ---------------------------------------------------------------- chalito_server (api, notifier, gateway)
-- What M2/M3 server code does today: provisioning and SSO (tenants, users, sso_tokens), enrolment,
-- revocation and recovery (devices, endorsements, private_recovery, device_nonces), pairing,
-- relayed commands (gateway), notifications and call lines (notifier), read-only views for MCP.
grant select, insert, update on chalito.tenants, chalito.users to chalito_server;
grant select, insert, update on chalito.devices to chalito_server;
grant select, insert on chalito.endorsements to chalito_server;
grant select, insert, update on chalito.pairing_codes to chalito_server;
grant select, insert, delete on chalito.commands to chalito_server;
grant select on chalito.sessions, chalito.session_events, chalito.approval_decisions, chalito.audit to chalito_server;
grant select, update (recommendations) on chalito.approvals to chalito_server;
grant select, insert, update on chalito.notifications to chalito_server;
grant select, delete on chalito.call_lines to chalito_server;
grant select, insert, update on chalito.companions, chalito.inventory to chalito_server;
grant select, insert, update on chalito_private.private_recovery to chalito_server;
grant select, insert on chalito_private.sso_tokens, chalito_private.device_nonces to chalito_server;

-- No BYPASSRLS: the server reaches rows through explicit policies, so a table it isn't granted
-- stays closed even if a policy is added by mistake.
do $$
declare
  t text;
begin
  foreach t in array array['chalito.tenants', 'chalito.users', 'chalito.devices', 'chalito.endorsements',
    'chalito.pairing_codes', 'chalito.commands', 'chalito.sessions', 'chalito.session_events', 'chalito.approvals',
    'chalito.approval_decisions', 'chalito.notifications', 'chalito.call_lines', 'chalito.audit',
    'chalito.companions', 'chalito.inventory', 'chalito_private.private_recovery', 'chalito_private.sso_tokens',
    'chalito_private.device_nonces']
  loop
    execute format('create policy server_all on %s for all to chalito_server using (true) with check (true)', t);
  end loop;
end
$$;
