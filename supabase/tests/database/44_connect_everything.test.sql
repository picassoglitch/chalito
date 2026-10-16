-- M16 D (migration 20261015000400): the link:handoff scope, chat-api / a2a app docs, A2A exposures
-- (the owner reads their own, the api writes, the gateway only reads), and the gateway's read of
-- app status rows.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

grant usage on schema extensions to chalito_server, chalito_gateway;

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into chalito.tenants (id) values ('ce-user'), ('ce-other');
insert into chalito.users (id, tenant_id) values ('ce-user', 'ce-user'), ('ce-other', 'ce-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('ce-user', 'ce_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('ce_phone')::uuid),
  ('ce-user', 'ce_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('ce_agent')::uuid),
  ('ce-other', 'ce_other_phone', 'client', 'phone', 'ios', 'P', 'p', 'p', 'f', 'first_client', md5('ce_other_phone')::uuid);

-- ---------------------------------------------------------------- 1. scopes
select ok('link:handoff' = any (chalito_private.mcp_scopes()), 'link:handoff exists');
set local role chalito_server;
select lives_ok($$insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource)
  values ('ce-user', 'con_a2a', 'https://agent.example/client.json', 'Agent', 'other', array['link:handoff'],
          'https://mcp.chalito.test/a2a')$$, 'a grant can carry link:handoff');
select throws_ok($$insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource)
  values ('ce-user', 'con_bad', 'c', 'X', 'other', array['link:admin'], 'r')$$, '23514', null,
  'still no scope beyond the list');
reset role;

-- ---------------------------------------------------------------- 2. app status docs
select ok(chalito_private.valid_connection_doc('{"mode": "api_key", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "chat-api", "custom": false}'),
  'a chat-api app doc is valid');
select ok(chalito_private.valid_connection_doc('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "a2a", "custom": false}'),
  'an a2a app doc is valid');
select ok(not chalito_private.valid_connection_doc('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "browser-bot", "custom": false}'),
  'an unknown kind is not');

-- ---------------------------------------------------------------- 3. exposures
set local role chalito_server;
select lives_ok($$insert into chalito.a2a_exposures (owner, exposure_id, app_id, device_id, workspace_label, card)
  values ('ce-user', 'a2x_0123456789abcdefABCD', 'claude-code', 'ce_agent', 'chalito',
          '{"name": "Claude Code", "description": "x", "version": "1", "capabilities": {},
            "defaultInputModes": ["text/plain"], "defaultOutputModes": ["text/plain"], "skills": []}')$$,
  'the api stores an exposure');
select throws_ok($$insert into chalito.a2a_exposures (owner, exposure_id, app_id, device_id, workspace_label, card)
  values ('ce-user', 'a2x_0123456789abcdefABCE', 'claude-code', 'ce_agent', 'chalito',
          '{"name": "x", "securitySchemes": {}}')$$, '23514', null,
  'a stored card never carries interfaces or security (the server adds them)');
select throws_ok($$insert into chalito.a2a_exposures (owner, exposure_id, app_id, device_id, workspace_label, card)
  values ('ce-user', 'guessable', 'claude-code', 'ce_agent', 'chalito', '{}')$$, '23514', null,
  'exposure ids are the opaque a2x_ form');
reset role;

select pg_temp.as_device('ce-user', 'ce_phone', 'client');
select is((select count(*)::int from chalito.a2a_exposures), 1, 'the owner reads their own exposures');
select throws_ok($$insert into chalito.a2a_exposures (owner, exposure_id, app_id, device_id, workspace_label, card)
  values ('ce-user', 'a2x_0123456789abcdefABCF', 'codex', 'ce_agent', 'w', '{}')$$, '42501', null,
  'a client can''t write an exposure directly (the api does)');
select pg_temp.logout();
select pg_temp.as_device('ce-other', 'ce_other_phone', 'client');
select is((select count(*)::int from chalito.a2a_exposures), 0, 'another owner sees none');
select pg_temp.logout();

set local role chalito_gateway;
select is((select app_id from chalito.a2a_exposures where exposure_id = 'a2x_0123456789abcdefABCD'), 'claude-code',
  'gateway: reads exposures');
select throws_ok($$update chalito.a2a_exposures set revoked_at = null$$, '42501', null, 'gateway: can''t change one');
select throws_ok($$insert into chalito.a2a_exposures select * from chalito.a2a_exposures limit 0$$, '42501', null,
  'gateway: can''t add one');
reset role;

-- ---------------------------------------------------------------- 4. the gateway reads app status
set local role chalito_gateway;
select lives_ok($$select owner, device_id, provider, doc from chalito.connections$$, 'gateway: reads app status rows');
reset role;
select is(
  (select array_agg(format('%I.%I', n.nspname, c.relname) order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('chalito', 'chalito_private') and c.relkind in ('r', 'p', 'v')
     and (has_table_privilege('chalito_gateway', c.oid, 'INSERT') or has_table_privilege('chalito_gateway', c.oid, 'UPDATE')
          or has_table_privilege('chalito_gateway', c.oid, 'DELETE') or has_table_privilege('chalito_gateway', c.oid, 'TRUNCATE'))),
  null, 'gateway: still no write privilege on any chalito table');

select * from finish();
rollback;
