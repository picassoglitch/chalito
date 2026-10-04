-- Migration 002800 (beta review R-L3, R-L5, R-L7): the plaintext MCP card is written only by the
-- session's own agent; sharing state can't be probed across accounts; the gateway reads only the
-- columns it shows.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

grant usage on schema extensions to chalito_gateway;

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

insert into chalito.tenants (id) values ('rm-user'), ('rm-other');
insert into chalito.users (id, tenant_id) values ('rm-user', 'rm-user'), ('rm-other', 'rm-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('rm-user', 'rm_a1', 'agent', 'desktop', 'linux', 'A1', 'ps', 'pb1', 'fp', 'pairing', md5('rm_a1')::uuid),
  ('rm-user', 'rm_a2', 'agent', 'laptop', 'macos', 'A2', 'ps', 'pb2', 'fp', 'pairing', md5('rm_a2')::uuid),
  ('rm-other', 'rm_x', 'client', 'phone', 'ios', 'X', 'ps', 'pbx', 'fp', 'first_client', md5('rm_x')::uuid);
insert into chalito.sessions (owner, sid, device_id, doc) values
  ('rm-user', 'rm_s1', 'rm_a1', '{"adapter": "claude-code", "state": "running", "label": "secret-project"}'),
  ('rm-user', 'rm_s2', 'rm_a2', '{"adapter": "codex", "state": "idle"}');
insert into chalito.mcp_sharing (owner, scope, target, enabled, plaintext_ack_at) values
  ('rm-user', 'device', 'rm_a1', true, now()), ('rm-user', 'session', 'rm_s2', true, now());

-- ---------------------------------------------------------------- R-L3
select pg_temp.as_device('rm-user', 'rm_a1', 'agent');
select throws_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('rm-user', 'rm_s2', 'rm_a1', '{"goal": "forged"}')$$, '42501', null,
  'R-L3: an agent can''t write the card of another agent''s session');
select lives_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('rm-user', 'rm_s1', 'rm_a1', '{"goal": "mine"}')$$, 'R-L3: it can write its own session''s card');
select pg_temp.logout();
select pg_temp.as_device('rm-user', 'rm_a2', 'agent');
select lives_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('rm-user', 'rm_s2', 'rm_a2', '{"goal": "a2"}')$$, 'R-L3: and the other agent its own (no squatting)');
select pg_temp.logout();

-- ---------------------------------------------------------------- R-L5
select pg_temp.as_device('rm-other', 'rm_x', 'client');
select throws_ok($$select chalito_private.mcp_sharing_on('rm-user', 'rm_s1', 'rm_a1')$$, '42501', null,
  'R-L5: another account can''t probe sharing state');
select is(chalito_private.mcp_sharing_on_mine('rm_s1', 'rm_a1'), false, 'R-L5: the caller''s own form sees only its own account');
select pg_temp.logout();
select pg_temp.as_device('rm-user', 'rm_a1', 'agent');
select is(chalito_private.mcp_sharing_on_mine('rm_s1', 'rm_a1'), true, 'R-L5: and its own sharing state');
select pg_temp.logout();

-- ---------------------------------------------------------------- R-L7
set local role chalito_gateway;
select throws_ok($$select doc from chalito.sessions$$, '42501', null, 'R-L7: the gateway can''t read sessions.doc');
select is((select adapter || '/' || state from chalito_private.gateway_sessions where sid = 'rm_s1'), 'claude-code/running',
  'R-L7: it reads adapter and state through the view');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'chalito_private' and table_name = 'gateway_sessions' and column_name = 'doc'), 0,
  'R-L7: the view has no doc column');
select throws_ok($$select details_ct from chalito.approvals$$, '42501', null, 'R-L7: nor approvals.details_ct');
select lives_ok($$select aid, risk, status, jsonb_array_length(recommendations) from chalito.approvals$$,
  'R-L7: approval metadata still readable');
select throws_ok($$select webauthn_binding from chalito.devices$$, '42501', null, 'R-L7: nor device passkey data');
select is((select pub_box from chalito.devices where device_id = 'rm_a1'), 'pb1', 'R-L7: box keys still readable');
select is((select count(*)::int from chalito.session_card_plain p
           where chalito_private.mcp_sharing_on(p.owner, p.sid, p.device_id)), 2, 'R-L7: shared cards still readable');
reset role;

select * from finish();
rollback;
