-- Tables mirroring the Firestore data model used through M3 (brief §6, firestore.rules on m3-agent).
-- Firestore path → table:
--   users/{uid}                                → chalito.tenants + chalito.users
--   users/{uid}/devices/{deviceId}             → chalito.devices
--   users/{uid}/endorsements/{deviceId}        → chalito.endorsements
--   users/{uid}/private/recovery               → chalito_private.private_recovery (not exposed)
--   pairingCodes/{codeId}                      → chalito.pairing_codes
--   users/{uid}/devices/{id}/commands/{cid}    → chalito.commands
--   users/{uid}/sessions/{sid}                 → chalito.sessions
--   users/{uid}/sessions/{sid}/events/{eid}    → chalito.session_events
--   users/{uid}/approvals/{aid}                → chalito.approvals
--   users/{uid}/notifications/{nid}            → chalito.notifications
--   users/{uid}/callLines/{lid}                → chalito.call_lines
--   users/{uid}/devices/{id}/audit/{eid}       → chalito.audit
--   users/{uid}/companions/{cid}               → chalito.companions
--   users/{uid}/inventory/{cosmeticId}         → chalito.inventory
--   ssoTokens/{sigHash}, deviceNonces/{id}     → chalito_private.sso_tokens, chalito_private.device_nonces
--
-- Conventions:
--   * Ids stay opaque text matching the protocol's `Id` ([A-Za-z0-9_-]{1,128}).
--   * Times are timestamptz. Server-owned times default to now() (the API layer converts epoch ms).
--   * `cursor` (identity) is the resync cursor for Realtime consumers: after (re)subscribing, a
--     device reads `cursor > last_seen` in order. It is never client-writable.
--   * `expires_at` marks TTL rows: invisible through RLS once past, deleted by pg_cron (ttl migration).
--   * No table is granted to `anon`. Grants to `authenticated` are column-scoped where Firestore
--     rules used `keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`.

create domain chalito.id as text check (value ~ '^[A-Za-z0-9_-]{1,128}$');

-- ---------------------------------------------------------------- tenants / users
create table chalito.tenants (
  id chalito.id primary key,
  name text,
  plan_source text not null default 'chalyb_handoff' check (plan_source in ('solo', 'chalyb_handoff')),
  created_at timestamptz not null default now(),
  schema_version smallint not null default 1
);

create table chalito.users (
  id chalito.id primary key,
  tenant_id chalito.id not null references chalito.tenants (id) on delete cascade,
  email text,
  display_name text,
  tier text,
  status text not null default 'active' check (status in ('active', 'paused')),
  status_at timestamptz,
  locale text not null default 'es' check (locale in ('es', 'en')),
  tz text,
  call_briefing jsonb not null default '{"enabled": false}',
  created_at timestamptz not null default now(),
  last_sso_at timestamptz,
  schema_version smallint not null default 1
);
create index users_tenant_id_idx on chalito.users (tenant_id);

-- ---------------------------------------------------------------- devices
create table chalito.devices (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  device_id chalito.id not null,
  role text not null check (role in ('agent', 'client')),
  kind text not null check (kind in ('desktop', 'laptop', 'phone', 'web')),
  platform text not null check (platform in ('linux', 'windows', 'macos', 'ios', 'android', 'web')),
  name text not null check (char_length(name) <= 40),
  pub_sign text not null,
  pub_box text not null,
  fingerprint text not null,
  enrolled_via text not null check (enrolled_via in ('first_client', 'endorsement', 'pairing', 'recovery')),
  endorsed_by chalito.id,
  revoked boolean not null default false,
  revoked_at timestamptz,
  revoked_by chalito.id,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  -- Written only by the device itself (rls migration).
  policy_hash text,
  dev_mode jsonb not null default '{"on": false, "toggles": [], "since": null}',
  status text,
  presence jsonb,
  last_event jsonb,
  cursor bigint generated always as identity,
  schema_version smallint not null default 1,
  primary key (owner, device_id)
);
-- Device ids are derived from the device's keys, so they are unique across owners. This also
-- makes `device:<id>` Realtime topics unambiguous and device_ok() a single index probe.
create unique index devices_device_id_key on chalito.devices (device_id);
create index devices_owner_cursor_idx on chalito.devices (owner, cursor);

create table chalito.endorsements (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  device_id chalito.id not null,
  endorsement jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner, device_id)
);

-- ---------------------------------------------------------------- pairing
create table chalito.pairing_codes (
  code_id chalito.id primary key,
  short_code_hash text not null unique check (short_code_hash ~ '^[0-9a-f]{64}$'),
  glyph jsonb not null,
  agent_device_id chalito.id not null,
  kind text not null check (kind in ('desktop', 'laptop')),
  platform text not null check (platform in ('linux', 'windows', 'macos')),
  claimed boolean not null default false,
  owner chalito.id references chalito.users (id) on delete cascade,
  claimed_by_device_id chalito.id,
  claimer_pub_sign text,
  claimer_pub_box text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  cursor bigint generated always as identity
);
create index pairing_codes_expires_at_idx on chalito.pairing_codes (expires_at);

-- ---------------------------------------------------------------- commands
-- Signed envelopes from a client to one agent. The agent verifies the signature against its
-- local trusted list; RLS only gates who may write and read.
create table chalito.commands (
  owner chalito.id not null,
  target_device_id chalito.id not null,
  id chalito.id not null,
  env jsonb not null,
  from_device_id chalito.id not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  cursor bigint generated always as identity,
  primary key (owner, target_device_id, id),
  foreign key (owner, target_device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index commands_target_cursor_idx on chalito.commands (target_device_id, cursor);
create index commands_expires_at_idx on chalito.commands (expires_at);

-- ---------------------------------------------------------------- sessions / events
-- The session card is schemaless in Firestore (`upsertSession(sid, data)`), so it stays a jsonb
-- document; `device_id` is lifted out because RLS checks it.
create table chalito.sessions (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  sid chalito.id not null,
  device_id chalito.id not null,
  doc jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cursor bigint generated always as identity,
  primary key (owner, sid)
);
create index sessions_owner_cursor_idx on chalito.sessions (owner, cursor);

create table chalito.session_events (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  sid chalito.id not null,
  eid chalito.id not null,
  device_id chalito.id not null,
  seq integer not null check (seq >= 0),
  t timestamptz not null,
  type text not null,
  urgency text not null default 'low' check (urgency in ('low', 'normal', 'high', 'critical')),
  doc jsonb not null,
  expires_at timestamptz not null default now() + interval '7 days',
  cursor bigint generated always as identity,
  primary key (owner, sid, eid)
);
create index session_events_owner_cursor_idx on chalito.session_events (owner, cursor);
create index session_events_expires_at_idx on chalito.session_events (expires_at);

-- ---------------------------------------------------------------- approvals
create table chalito.approvals (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  aid chalito.id not null,
  device_id chalito.id not null,
  sid chalito.id not null,
  request_id chalito.id not null,
  kind text not null check (kind in ('tool', 'decision')),
  risk text not null check (risk in ('LOW', 'MED', 'HIGH', 'CRITICAL')),
  origin text not null,
  step_up_required boolean not null,
  details_ct jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'rejected_invalid')),
  -- A signed decision attached by a client; binding only once the agent verifies it.
  decision jsonb,
  reason text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  recommendations jsonb not null default '[]',
  cursor bigint generated always as identity,
  primary key (owner, aid),
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check (risk not in ('HIGH', 'CRITICAL') or step_up_required)
);
create index approvals_owner_cursor_idx on chalito.approvals (owner, cursor);

-- ---------------------------------------------------------------- notifications / call lines
create table chalito.notifications (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  nid chalito.id not null,
  level text not null check (level in ('L0', 'L1', 'L2', 'L3', 'L4')),
  source text not null,
  urgency text not null check (urgency in ('low', 'normal', 'high', 'critical')),
  counts jsonb not null,
  deep_link text not null,
  coalesce_key text not null check (char_length(coalesce_key) <= 128),
  state text not null default 'pending' check (state in ('pending', 'acked', 'snoozed', 'expired')),
  step integer not null default 0 check (step >= 0),
  next_at timestamptz,
  channels text[] not null default '{}',
  created_at timestamptz not null default now(),
  acked_at timestamptz,
  acked_via text,
  cursor bigint generated always as identity,
  primary key (owner, nid)
);
create index notifications_owner_cursor_idx on chalito.notifications (owner, cursor);

-- Opt-in plaintext call lines: written/deleted by the publishing agent, read by the notifier.
create table chalito.call_lines (
  owner chalito.id not null,
  lid chalito.id not null,
  notification_id chalito.id not null,
  device_id chalito.id not null,
  sid chalito.id not null,
  line text not null check (char_length(line) between 1 and 160),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner, lid),
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index call_lines_expires_at_idx on chalito.call_lines (expires_at);

-- ---------------------------------------------------------------- audit
-- Append-only, written by an agent about itself. `t` is always server time (rls migration).
create table chalito.audit (
  owner chalito.id not null,
  device_id chalito.id not null,
  eid chalito.id not null,
  t timestamptz not null default now(),
  type text not null check (char_length(type) <= 64),
  meta jsonb not null default '{}' check (octet_length(meta::text) <= 8192),
  source text not null check (source in ('agent', 'deviceEvent')),
  cursor bigint generated always as identity,
  primary key (owner, device_id, eid),
  foreign key (owner, device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index audit_owner_cursor_idx on chalito.audit (owner, cursor);

-- ---------------------------------------------------------------- companions / inventory
-- Equipping is server-validated against inventory, so clients can't change `equipped`.
create table chalito.companions (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  companion_id text not null check (companion_id ~ '^chl_[a-z2-7]{26}$'),
  name text not null,
  is_renamed boolean not null default false,
  persona text,
  voice jsonb,
  style text,
  render_quality text,
  asset_id text,
  equipped jsonb not null default '{}',
  expression_map jsonb,
  created_at timestamptz not null default now(),
  primary key (owner, companion_id)
);

create table chalito.inventory (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  cosmetic_id text not null,
  acquired_at timestamptz not null default now(),
  via text not null check (via in ('purchase', 'grant', 'free')),
  purchase_id text,
  primary key (owner, cosmetic_id)
);

-- ---------------------------------------------------------------- server only (not exposed)
create table chalito_private.private_recovery (
  owner chalito.id primary key references chalito.users (id) on delete cascade,
  -- RecoveryHash from apps/api/src/lib/recovery.ts: { alg, salt, hash, N, r, p }
  code_hash jsonb not null,
  cooldown_until timestamptz,
  started_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Single-use hub SSO launch tokens.
create table chalito_private.sso_tokens (
  sig_hash text primary key,
  expires_at timestamptz not null
);
create index sso_tokens_expires_at_idx on chalito_private.sso_tokens (expires_at);

-- Device refresh-challenge nonces (replay protection).
create table chalito_private.device_nonces (
  device_id chalito.id not null,
  nonce text not null,
  expires_at timestamptz not null,
  primary key (device_id, nonce)
);
create index device_nonces_expires_at_idx on chalito_private.device_nonces (expires_at);

-- ---------------------------------------------------------------- RLS on, grants
alter table chalito.tenants enable row level security;
alter table chalito.users enable row level security;
alter table chalito.devices enable row level security;
alter table chalito.endorsements enable row level security;
alter table chalito.pairing_codes enable row level security;
alter table chalito.commands enable row level security;
alter table chalito.sessions enable row level security;
alter table chalito.session_events enable row level security;
alter table chalito.approvals enable row level security;
alter table chalito.notifications enable row level security;
alter table chalito.call_lines enable row level security;
alter table chalito.audit enable row level security;
alter table chalito.companions enable row level security;
alter table chalito.inventory enable row level security;
alter table chalito_private.private_recovery enable row level security;
alter table chalito_private.sso_tokens enable row level security;
alter table chalito_private.device_nonces enable row level security;

-- Start from nothing, whatever the project's default privileges are.
revoke all on all tables in schema chalito from public, anon, authenticated;
revoke all on all tables in schema chalito_private from public, anon, authenticated;
revoke all on all sequences in schema chalito from public, anon, authenticated;
revoke all on all sequences in schema chalito_private from public, anon, authenticated;

-- The API and notifier run as service_role (RLS bypassed), like the Firestore Admin SDK did.
grant all on all tables in schema chalito to service_role;
grant all on all tables in schema chalito_private to service_role;
grant usage on all sequences in schema chalito to service_role;

-- Column-scoped client grants (firestore.rules `hasOnly` / `affectedKeys().hasOnly`).
grant select on chalito.users, chalito.devices, chalito.endorsements, chalito.pairing_codes,
  chalito.commands, chalito.sessions, chalito.session_events, chalito.approvals,
  chalito.notifications, chalito.audit, chalito.companions, chalito.inventory to authenticated;

grant update (last_seen_at, policy_hash, dev_mode, status, presence, last_event)
  on chalito.devices to authenticated;

grant insert (owner, target_device_id, id, env, from_device_id, expires_at) on chalito.commands to authenticated;
grant delete on chalito.commands to authenticated;

grant insert (owner, sid, device_id, doc) on chalito.sessions to authenticated;
grant update (device_id, doc) on chalito.sessions to authenticated;

grant insert (owner, sid, eid, device_id, seq, t, type, urgency, doc, expires_at)
  on chalito.session_events to authenticated;

grant insert (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required,
  details_ct, status, created_at, expires_at, recommendations) on chalito.approvals to authenticated;
grant update (decision, status, reason, resolved_at) on chalito.approvals to authenticated;

grant update (state, acked_at, acked_via) on chalito.notifications to authenticated;

-- The publishing agent may see only the keys of its own lines (enough to delete them); the
-- notifier reads them as service_role.
grant select (owner, lid, device_id, expires_at) on chalito.call_lines to authenticated;
grant insert (owner, lid, notification_id, device_id, sid, line, expires_at) on chalito.call_lines to authenticated;
grant delete on chalito.call_lines to authenticated;

-- `t` is accepted but overwritten with server time by a trigger.
grant insert (owner, device_id, eid, t, type, meta, source) on chalito.audit to authenticated;

grant update (name, is_renamed, persona, voice, style, render_quality) on chalito.companions to authenticated;
