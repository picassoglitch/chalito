-- M10 (migrations 001700, 001800): the MCP gateway's role is READ-ONLY (D-035): it can't write
-- decisions, devices (policy, devmode), endorsements, commands, grants, rooms or billing. Card
-- sharing: the agent may store a plaintext card only while sharing is on; turning it off deletes it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- pgTAP lives in `extensions`; let the test roles call it inside this (rolled-back) test only.
grant usage on schema extensions to chalito_server, chalito_gateway;

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into chalito.tenants (id) values ('mc-user');
insert into chalito.users (id, tenant_id) values ('mc-user', 'mc-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('mc-user', 'mc_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('mc_phone')::uuid),
  ('mc-user', 'mc_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('mc_agent')::uuid);
insert into chalito.sessions (owner, sid, device_id, doc) values
  ('mc-user', 's_1', 'mc_agent', '{"state": "running"}'), ('mc-user', 's_2', 'mc_agent', '{}');
insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
values ('mc-user', 'apr_1', 'mc_agent', 's_1', 'req_1', 'tool', 'HIGH', 'mcp:claude', true, '{}', now() + interval '5 minutes');

-- ---------------------------------------------------------------- grants (the api writes them)
set local role chalito_server;
insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource)
values ('mc-user', 'con_1', 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude', 'claude',
        array['mcp:read', 'session:prompt'], 'https://mcp.chalito.chalyb.com/mcp');
insert into chalito_private.oauth_tokens (token_hash, kind, owner, cid, client_id, scopes, resource, expires_at)
values (repeat('a', 64), 'access', 'mc-user', 'con_1', 'c', array['mcp:read'], 'https://mcp.chalito.chalyb.com/mcp',
        now() + interval '15 minutes');
select throws_ok($$insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource)
  values ('mc-user', 'con_2', 'c', 'X', 'other', array['approval:decide'], 'r')$$, '23514', null,
  'scopes: approval:decide doesn''t exist');
select throws_ok($$insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource)
  values ('mc-user', 'con_3', 'c', 'X', 'other', array['devmode'], 'r')$$, '23514', null,
  'scopes: nor devmode (or policy, rooms, billing)');
reset role;

-- ---------------------------------------------------------------- the gateway reads ...
set local role chalito_gateway;
select is((select count(*)::int from chalito_private.oauth_tokens t join chalito.connectors c using (owner, cid)
           where t.token_hash = repeat('a', 64) and c.revoked_at is null), 1, 'gateway: reads token hashes and grants');
select is((select count(*)::int from chalito.approvals where status = 'pending'), 1, 'gateway: reads pending approvals');
select is((select count(*)::int from chalito.devices where role = 'client'), 1, 'gateway: reads devices (box keys)');
select throws_ok($$select * from chalito_private.oauth_codes$$, '42501', null, 'gateway: can''t read codes');
select throws_ok($$select * from chalito.commands$$, '42501', null, 'gateway: can''t read commands');

-- ---------------------------------------------------------------- ... and writes nothing
select throws_ok($$update chalito.approvals set status = 'approved' where aid = 'apr_1'$$, '42501', null,
  'gateway: can''t resolve an approval');
select throws_ok($$insert into chalito.approval_decisions select * from chalito.approval_decisions limit 0$$, '42501', null,
  'gateway: can''t attach a decision');
select throws_ok($$update chalito.approvals set recommendations = '[{}]' where aid = 'apr_1'$$, '42501', null,
  'gateway: can''t even recommend directly (the api does)');
select throws_ok($$update chalito.devices set policy_hash = 'x' where device_id = 'mc_agent'$$, '42501', null,
  'gateway: can''t change a device''s policy');
select throws_ok($$update chalito.devices set dev_mode = '{"on": true}' where device_id = 'mc_agent'$$, '42501', null,
  'gateway: can''t turn on Developer mode');
select throws_ok($$update chalito.devices set revoked = true where device_id = 'mc_phone'$$, '42501', null,
  'gateway: can''t revoke or admin devices');
select throws_ok($$insert into chalito.endorsements select * from chalito.endorsements limit 0$$, '42501', null,
  'gateway: can''t endorse');
select throws_ok($$insert into chalito.commands (owner, target_device_id, id, env, from_device_id)
  values ('mc-user', 'mc_agent', 'x', '{}', 'mcp-gateway')$$, '42501', null, 'gateway: can''t queue commands');
select throws_ok($$update chalito.connectors set revoked_at = null, scopes = array['session:prompt']$$, '42501', null,
  'gateway: can''t widen or un-revoke a grant');
select throws_ok($$insert into chalito_private.oauth_tokens select * from chalito_private.oauth_tokens limit 0$$, '42501', null,
  'gateway: can''t mint tokens');
select throws_ok($$insert into chalito.rooms (room_id) values ('r1')$$, '42501', null, 'gateway: can''t touch rooms');
select throws_ok($$insert into chalito_private.purchases select * from chalito_private.purchases limit 0$$, '42501', null,
  'gateway: can''t touch billing');
select throws_ok($$insert into chalito.mesa_turns (owner, mid, tid) values ('mc-user', 'm', 't')$$, '42501', null,
  'gateway: can''t post to Mesa directly');
select throws_ok($$update chalito.mcp_sharing set enabled = true$$, '42501', null, 'gateway: can''t turn sharing on');
reset role;

-- Every table, present and future (billing, rooms, ...): no write privilege, no write function.
select is(
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('chalito', 'chalito_private') and c.relkind in ('r', 'p', 'v')
     and (has_table_privilege('chalito_gateway', c.oid, 'INSERT') or has_table_privilege('chalito_gateway', c.oid, 'UPDATE')
          or has_table_privilege('chalito_gateway', c.oid, 'DELETE') or has_table_privilege('chalito_gateway', c.oid, 'TRUNCATE'))),
  null, 'gateway: no write privilege on any chalito table');
select is(
  (select array_agg(n.nspname || '.' || p.proname order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('chalito', 'chalito_private') and has_function_privilege('chalito_gateway', p.oid, 'EXECUTE')),
  array['chalito_private.mcp_sharing_on'], 'gateway: the only function it can call is the read-only sharing check');
select ok(not (select rolbypassrls or rolsuper or rolcanlogin from pg_roles where rolname = 'chalito_gateway'),
  'gateway: no login, no superuser, no RLS bypass');

-- ---------------------------------------------------------------- card sharing
-- Off by default: the agent can't store a plaintext card.
select pg_temp.as_device('mc-user', 'mc_agent', 'agent');
select throws_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('mc-user', 's_1', 'mc_agent', '{"goal": "x"}')$$, '42501', null, 'sharing off: the agent can''t store plaintext');
select pg_temp.logout();

-- On (with the plaintext acknowledgement, set by the api): it can.
set local role chalito_server;
select throws_ok($$insert into chalito.mcp_sharing (owner, scope, target, enabled) values ('mc-user', 'session', 's_1', true)$$,
  '23514', null, 'sharing on requires the plaintext acknowledgement');
insert into chalito.mcp_sharing (owner, scope, target, enabled, plaintext_ack_at) values
  ('mc-user', 'session', 's_1', true, now()), ('mc-user', 'session', 's_2', true, now()),
  ('mc-user', 'device', 'mc_agent', true, now());
reset role;
select pg_temp.as_device('mc-user', 'mc_agent', 'agent');
select lives_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card) values
  ('mc-user', 's_1', 'mc_agent', '{"goal": "fix login"}'), ('mc-user', 's_2', 'mc_agent', '{"goal": "docs"}')$$,
  'sharing on: the agent stores the plaintext card');
select throws_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('mc-user', 's_1', 'mc_phone', '{}')$$, '42501', null, 'only for its own device');
select pg_temp.logout();

set local role chalito_gateway;
select is((select card ->> 'goal' from chalito.session_card_plain where sid = 's_1'
           and chalito_private.mcp_sharing_on(owner, sid, device_id)), 'fix login', 'gateway: reads a shared card');
reset role;

-- Off: the plaintext copy is deleted (unless another switch still covers it).
set local role chalito_server;
update chalito.mcp_sharing set enabled = false where scope = 'session' and target = 's_1';
reset role;
select is((select count(*)::int from chalito.session_card_plain where sid = 's_1'), 1,
  'session switch off while the device switch is on: kept');
set local role chalito_server;
update chalito.mcp_sharing set enabled = false where scope = 'device' and target = 'mc_agent';
reset role;
select is((select count(*)::int from chalito.session_card_plain where sid = 's_1'), 0,
  'every switch off: the plaintext card is deleted');
select is((select count(*)::int from chalito.session_card_plain where sid = 's_2'), 1,
  'a session still shared on its own keeps its card');

select * from finish();
rollback;
