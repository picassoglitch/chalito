-- RLS: a port of apps/api/test/rules.emu.test.ts (firestore.rules) plus the relayedBy, audit and
-- revocation cases. Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(74);

-- ---------------------------------------------------------------- helpers
-- Act as a Chalito principal: the claims PostgREST would set after verifying the JWT. Devices are
-- Supabase Auth users (sub = the device's auth user id, md5(device_id) in these fixtures) with
-- app_metadata.chalito set by the API; a person's web session is their hub account (sub = owner).
create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'provider', 'chalito', 'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.as_pairing(code text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5('watch:' || code)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('role', 'pairing', 'pairing_code', code)))) $$;
create function pg_temp.as_client(owner text, device text) returns void language sql as $$
  select pg_temp.as_device(owner, device, 'client') $$;
create function pg_temp.as_agent(owner text, device text) returns void language sql as $$
  select pg_temp.as_device(owner, device, 'agent') $$;
create function pg_temp.as_user(owner text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', owner, 'app_metadata', '{"provider": "email"}'::jsonb)) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- Rows a statement touched (RLS-filtered updates/deletes affect 0 rows instead of failing).
create function pg_temp.affected(stmt text) returns integer language plpgsql as $$
declare n integer;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;
create function pg_temp.count(q text) returns integer language plpgsql as $$
declare n integer;
begin
  execute format('select count(*) from (%s) as q', q) into n;
  return n;
end $$;

-- ---------------------------------------------------------------- fixtures (as postgres)
insert into chalito.tenants (id) values ('user-1'), ('user-2');
insert into chalito.users (id, tenant_id) values ('user-1', 'user-1'), ('user-2', 'user-2');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('user-1', 'phone1',   'client', 'phone',   'ios',   'Phone',     'ps', 'pb', 'fp', 'first_client', false),
  ('user-1', 'agent1',   'agent',  'desktop', 'linux', 'Desk',      'ps', 'pb', 'fp', 'pairing',      false),
  ('user-1', 'oldphone', 'client', 'phone',   'ios',   'Old phone', 'ps', 'pb', 'fp', 'first_client', true),
  ('user-1', 'oldagent', 'agent',  'desktop', 'linux', 'Old desk',  'ps', 'pb', 'fp', 'pairing',      true),
  ('user-2', 'phoneX',   'client', 'phone',   'ios',   'Other',     'ps', 'pb', 'fp', 'first_client', false);
update chalito.devices set auth_user_id = md5(device_id)::uuid;
insert into chalito.sessions (owner, sid, device_id) values ('user-1', 's1', 'agent1');
insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
values ('user-1', 'agent1', 'c1', '{"ctx": "chalito.command.v1"}', 'phone1');
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required,
  details_ct, status, expires_at)
values ('user-1', 'a1', 'agent1', 's1', 'r1', 'tool', 'MED', 'client:phone1', false, '{}', 'pending',
  now() + interval '10 minutes');
insert into chalito_private.private_recovery (owner, code_hash) values ('user-1', '{"alg": "scrypt"}');
insert into chalito.companions (owner, companion_id, name) values ('user-1', 'chl_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Chalito');
insert into chalito.pairing_codes (code_id, short_code_hash, glyph, agent_device_id, kind, platform, expires_at)
values
  ('code123', repeat('a', 64), '{}', 'agentNew', 'desktop', 'linux', now() + interval '5 minutes'),
  ('other',   repeat('b', 64), '{}', 'agentNew2', 'desktop', 'linux', now() + interval '5 minutes'),
  ('stale',   repeat('c', 64), '{}', 'agentNew3', 'desktop', 'linux', now() - interval '1 second');
update chalito.pairing_codes set watch_auth_user_id = md5('watch:' || code_id)::uuid;

-- ================================================================ commands
-- Firestore: "an active client of the same owner may send a command to an agent"
select pg_temp.as_client('user-1', 'phone1');
select lives_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c2', '{"ctx": "chalito.command.v1"}', 'phone1')$$,
  'commands: an active client of the same owner sends a command to an agent');

-- "a revoked client, another account's client, a user session or an agent may not"
select pg_temp.as_client('user-1', 'oldphone');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c3', '{"ctx": "chalito.command.v1"}', 'oldphone')$$, '42501', null,
  'commands: a revoked client may not');
select pg_temp.as_client('user-2', 'phoneX');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c3', '{"ctx": "chalito.command.v1"}', 'phoneX')$$, '42501', null,
  'commands: another account''s client may not');
select pg_temp.as_user('user-1');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c3', '{"ctx": "chalito.command.v1"}', 'phone1')$$, '42501', null,
  'commands: a user session may not');
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c3', '{"ctx": "chalito.command.v1"}', 'agent1')$$, '42501', null,
  'commands: an agent may not');

-- "a client can't write an unsigned relayed command or a non-command envelope"
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c4', '{"relayedBy": "mcp-gateway", "body": {"origin": "mcp:claude"}}', 'phone1')$$,
  '42501', null, 'commands: a client can''t write a relayed envelope');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c4', '{"ctx": "chalito.command.v1", "relayedBy": "mcp-gateway"}', 'phone1')$$,
  '42501', null, 'commands: a client can''t add relayedBy to a signed command');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c4', '{"ctx": "chalito.decision.v1"}', 'phone1')$$,
  '42501', null, 'commands: a non-command envelope is refused');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c4', '{}', 'phone1')$$,
  '42501', null, 'commands: an empty envelope is refused');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c4', '"chalito.command.v1"', 'phone1')$$,
  '42501', null, 'commands: a non-object envelope is refused');

-- "a client can't spoof the sender"
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'agent1', 'c5', '{"ctx": "chalito.command.v1"}', 'someoneelse')$$,
  '42501', null, 'commands: a client can''t spoof the sender');

-- Beyond Firestore: only to an active agent, and only the envelope columns.
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'oldagent', 'c6', '{"ctx": "chalito.command.v1"}', 'phone1')$$,
  '42501', null, 'commands: not to a revoked agent');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('user-1', 'phone1', 'c6', '{"ctx": "chalito.command.v1"}', 'phone1')$$,
  '42501', null, 'commands: not to a client device');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id, created_at)
  values ('user-1', 'agent1', 'c6', '{"ctx": "chalito.command.v1"}', 'phone1', now())$$,
  '42501', null, 'commands: a client can''t set server fields (created_at)');

-- "only the target agent reads its commands, and a revoked agent can't"
select pg_temp.as_agent('user-1', 'agent1');
select is(pg_temp.count($$select 1 from chalito.commands where id = 'c1'$$), 1,
  'commands: the target agent reads its command');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.count($$select 1 from chalito.commands where id = 'c1'$$), 0,
  'commands: a client can''t read commands');
select pg_temp.as_agent('user-1', 'oldagent');
select is(pg_temp.count($$select 1 from chalito.commands where id = 'c1'$$), 0,
  'commands: a revoked agent can''t read them');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.affected($$delete from chalito.commands where id = 'c1'$$), 0,
  'commands: a client can''t delete them');
select pg_temp.as_agent('user-1', 'agent1');
select is(pg_temp.affected($$delete from chalito.commands where id = 'c2'$$), 1,
  'commands: the target agent deletes (acknowledges) its command');
select throws_ok($$update chalito.commands set env = '{}' where id = 'c1'$$, '42501', null,
  'commands: no one updates a command');

-- ================================================================ audit trail
-- "the active agent appends entries about itself; members read them"
select pg_temp.as_agent('user-1', 'agent1');
select lives_ok($$insert into chalito.audit (owner, device_id, eid, t, type, meta, source)
  values ('user-1', 'agent1', 'e1', '2000-01-01', 'command.rejected', '{}', 'agent')$$,
  'audit: the active agent appends an entry about itself');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.count($$select 1 from chalito.audit where eid = 'e1'$$), 1, 'audit: members read entries');
select pg_temp.logout();
select is((select t from chalito.audit where eid = 'e1'), now(), 'audit: t is server time, not the client''s value');

-- "entries can't be updated or deleted, even by the agent"
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$update chalito.audit set type = 'x' where eid = 'e1'$$, '42501', null,
  'audit: the agent can''t update an entry');
select throws_ok($$delete from chalito.audit where eid = 'e1'$$, '42501', null,
  'audit: the agent can''t delete an entry');

-- "no one else writes a device's audit: other agents, revoked agents, clients, extra fields"
select pg_temp.as_agent('user-1', 'oldagent');
select throws_ok($$insert into chalito.audit (owner, device_id, eid, type, source)
  values ('user-1', 'oldagent', 'e2', 'x', 'agent')$$, '42501', null, 'audit: a revoked agent can''t write');
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$insert into chalito.audit (owner, device_id, eid, type, source)
  values ('user-1', 'agent1', 'e2', 'x', 'agent')$$, '42501', null, 'audit: a client can''t write');
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$insert into chalito.audit (owner, device_id, eid, type, source)
  values ('user-1', 'phone1', 'e2', 'x', 'agent')$$, '42501', null, 'audit: an agent can''t write about another device');
select throws_ok($$insert into chalito.audit (owner, device_id, eid, type, source, cursor)
  values ('user-1', 'agent1', 'e2', 'x', 'agent', 1)$$, '428C9', null, 'audit: no extra fields (cursor is server-owned)');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id, cursor)
  values ('user-1', 'agent1', 'c9', '{"ctx": "chalito.command.v1"}', 'phone1', 1)$$, '428C9', null,
  'commands: the cursor is server-owned');
select throws_ok(format($$insert into chalito.audit (owner, device_id, eid, type, meta, source)
  values ('user-1', 'agent1', 'e3', 'x', %L, 'agent')$$, jsonb_build_object('blob', repeat('x', 9000))),
  '23514', null, 'audit: meta is capped at 8 KB');
select pg_temp.as_client('user-2', 'phoneX');
select is(pg_temp.count($$select 1 from chalito.audit where owner = 'user-1'$$), 0,
  'audit: another account can''t read it');

-- ================================================================ devices
-- "devMode and policyHash are written only by the device itself"
select pg_temp.as_agent('user-1', 'agent1');
select is(pg_temp.affected($$update chalito.devices set policy_hash = 'ab',
  dev_mode = '{"on": false, "toggles": [], "since": null}' where device_id = 'agent1'$$), 1,
  'devices: the agent writes its own policyHash and devMode');
select is(pg_temp.affected($$update chalito.devices set policy_hash = 'ab' where device_id = 'oldagent'$$), 0,
  'devices: an agent can''t write another device');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.affected($$update chalito.devices set dev_mode = '{"on": true, "toggles": ["allowSudo"], "since": 1}'
  where device_id = 'agent1'$$), 0, 'devices: a client can''t set an agent''s devMode');
select is(pg_temp.affected($$update chalito.devices set last_seen_at = now() where device_id = 'phone1'$$), 0,
  'devices: a client can''t update even its own device');
select pg_temp.as_user('user-1');
select is(pg_temp.affected($$update chalito.devices set policy_hash = 'ab' where device_id = 'agent1'$$), 0,
  'devices: a user session can''t set policyHash');

-- "no client can add, un-revoke or delete devices (server only)"
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box,
  fingerprint, enrolled_via) values ('user-1', 'evil', 'client', 'phone', 'ios', 'x', 'p', 'p', 'f', 'first_client')$$,
  '42501', null, 'devices: a client can''t add a device');
select pg_temp.as_agent('user-1', 'oldagent');
select throws_ok($$update chalito.devices set revoked = false where device_id = 'oldagent'$$, '42501', null,
  'devices: a revoked agent can''t un-revoke itself');
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$update chalito.devices set pub_sign = 'x' where device_id = 'agent1'$$, '42501', null,
  'devices: an agent can''t replace its keys');
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$delete from chalito.devices where device_id = 'agent1'$$, '42501', null,
  'devices: a client can''t delete a device');

-- "owners read their devices; other accounts can't"
select pg_temp.as_user('user-1');
select is(pg_temp.count($$select 1 from chalito.devices where device_id = 'phone1'$$), 1,
  'devices: the owner''s session reads them');
select pg_temp.as_client('user-2', 'phoneX');
select is(pg_temp.count($$select 1 from chalito.devices where owner = 'user-1'$$), 0,
  'devices: another account can''t');

-- ================================================================ approvals
-- Firestore: "a client may attach a decision only; the agent resolves only status fields". Since the
-- security review (S6) decisions are insert-only rows in approval_decisions, one per signer.
select pg_temp.as_client('user-1', 'phone1');
select lives_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'phone1', '{"sig": "x"}')$$, 'approvals: a client attaches a decision while pending');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'phone1', '{"sig": "again"}')$$, '23505', null,
  'approvals: a signer''s decision can''t be replaced');
select throws_ok($$update chalito.approval_decisions set decision = '{"sig": "y"}' where aid = 'a1'$$, '42501', null,
  'approvals: decisions are never updated');
select throws_ok($$delete from chalito.approval_decisions where aid = 'a1'$$, '42501', null,
  'approvals: or deleted');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'someoneelse', '{"sig": "x"}')$$, '42501', null, 'approvals: a client can''t sign as another device');
select is(pg_temp.affected($$update chalito.approvals set status = 'approved' where aid = 'a1'$$), 0,
  'approvals: a client can''t set the status');
select pg_temp.as_client('user-1', 'oldphone');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'oldphone', '{"sig": "x"}')$$, '42501', null, 'approvals: a revoked client can''t decide');
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'agent1', '{"sig": "forged"}')$$, '42501', null, 'approvals: the agent can''t write a decision');
select is(pg_temp.count($$select 1 from chalito.approval_decisions where aid = 'a1'$$), 1,
  'approvals: the agent reads the decisions');
select throws_ok($$update chalito.approvals set expires_at = now() where aid = 'a1'$$, '42501', null,
  'approvals: the agent can''t touch other columns');
select is(pg_temp.affected($$update chalito.approvals set status = 'approved', resolved_at = now(),
  reason = 'signed_allow' where aid = 'a1'$$), 1, 'approvals: the owning agent resolves it');
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$insert into chalito.approval_decisions (owner, aid, signer_device_id, decision)
  values ('user-1', 'a1', 'phone1', '{"sig": "late"}')$$, '42501', null, 'approvals: no decisions once resolved');
select pg_temp.as_agent('user-1', 'agent1');
select throws_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, status, expires_at) values ('user-1', 'a2', 'agent1', 's1', 'r2', 'tool', 'LOW',
  'local', false, '{}', 'approved', now() + interval '5 minutes')$$, '42501', null,
  'approvals: an agent creates them only as pending');
select lives_ok($$insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin,
  step_up_required, details_ct, status, expires_at) values ('user-1', 'a3', 'agent1', 's1', 'r3', 'tool', 'LOW',
  'local', false, '{}', 'pending', now() + interval '5 minutes')$$, 'approvals: an agent creates a pending one');

-- ================================================================ sessions / events
select pg_temp.as_agent('user-1', 'agent1');
select lives_ok($$insert into chalito.sessions (owner, sid, device_id, doc) values ('user-1', 's9', 'agent1', '{"state": "running"}')$$,
  'sessions: an agent writes its own session');
select throws_ok($$insert into chalito.sessions (owner, sid, device_id, doc) values ('user-1', 's2', 'phone1', '{}')$$,
  '42501', null, 'sessions: not on behalf of another device');
select lives_ok($$insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
  values ('user-1', 's1', 'ev1', 'agent1', 0, now(), 'session.started', '{}')$$, 'events: the agent appends events');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.count($$select 1 from chalito.session_events where sid = 's1'$$), 1, 'events: members read them');
select throws_ok($$insert into chalito.sessions (owner, sid, device_id, doc) values ('user-1', 's3', 'phone1', '{}')$$,
  '42501', null, 'sessions: a client can''t write sessions');

-- ================================================================ server-only and scoped rows
-- "private docs, inventory and equipping are server only"
select pg_temp.as_client('user-1', 'phone1');
select throws_ok($$select * from chalito_private.private_recovery$$, '42501', null,
  'private: the recovery hash is unreadable');
select throws_ok($$insert into chalito.inventory (owner, cosmetic_id, via) values ('user-1', 'viking_hat', 'free')$$,
  '42501', null, 'inventory: server only');
select throws_ok($$update chalito.companions set equipped = '{"head": "viking_hat"}' where owner = 'user-1'$$,
  '42501', null, 'companions: equipping is server only');
select is(pg_temp.affected($$update chalito.companions set name = 'Batman', is_renamed = true where owner = 'user-1'$$), 1,
  'companions: a client renames the companion');

-- "a pairing watch token reads only its own code"
select pg_temp.as_pairing('code123');
select is(pg_temp.count($$select 1 from chalito.pairing_codes where code_id = 'code123'$$), 1,
  'pairing: the watch token reads its code');
select is(pg_temp.count($$select 1 from chalito.pairing_codes where code_id = 'other'$$), 0,
  'pairing: not another code');
select is(pg_temp.count($$select 1 from chalito.users$$), 0, 'pairing: nothing else');
select pg_temp.as_pairing('stale');
select is(pg_temp.count($$select 1 from chalito.pairing_codes$$), 0, 'pairing: an expired code is invisible');
select pg_temp.as_client('user-1', 'phone1');
select is(pg_temp.count($$select 1 from chalito.pairing_codes$$), 0, 'pairing: a client can''t read codes');

-- "unauthenticated access is denied"
select pg_temp.logout();
set local role anon;
select throws_ok($$select * from chalito.users$$, '42501', null, 'anon: denied');
reset role;

-- ================================================================ revocation takes effect on the next read
select pg_temp.as_agent('user-1', 'agent1');
select is(pg_temp.count($$select 1 from chalito.approvals$$), 2, 'revocation: the agent reads approvals');
select pg_temp.logout();
update chalito.devices set revoked = true, revoked_at = now() where device_id = 'agent1';
select pg_temp.as_agent('user-1', 'agent1');
select is(pg_temp.count($$select 1 from chalito.approvals$$), 0, 'revocation: denied on the very next read');
select pg_temp.logout();

select * from finish();
rollback;
