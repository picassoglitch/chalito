-- Migration 20261015000300 (ADR 0022 §3): the agent_links mirror. An agent publishes only its own
-- rows (through the RPC), never un-revokes a row; the owner's devices read; revoke-all (the
-- server) marks every link of the account; other accounts see nothing.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- pgTAP lives in `extensions`; the server role needs it for the assertions it runs below.
grant usage on schema extensions to chalito_server;

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object('provider', 'chalito',
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.link(id text, sender text, receiver text, made timestamptz default now() - interval '1 minute')
returns jsonb language sql as $$
  select jsonb_build_object('link_id', id, 'mode', 'handoff', 'sender_device_id', sender, 'receiver_device_id', receiver,
    'confirm', true, 'permission_ceiling', 'default', 'expires_at', (now() + interval '1 day')::text,
    'created_at', made::text, 'revoked_at', null, 'details_ct', '{"alg": "x"}'::jsonb) $$;

insert into chalito.tenants (id) values ('lk-user'), ('lk-other');
insert into chalito.users (id, tenant_id) values ('lk-user', 'lk-user'), ('lk-other', 'lk-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, revoked)
values
  ('lk-user', 'lk_a', 'agent', 'desktop', 'linux', 'A', 'p', 'p', 'f', 'pairing', false),
  ('lk-user', 'lk_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', false),
  ('lk-other', 'lk_x', 'client', 'phone', 'ios', 'X', 'p', 'p', 'f', 'first_client', false);
update chalito.devices set auth_user_id = md5(device_id)::uuid;

select pg_temp.as_device('lk-user', 'lk_a', 'agent');
select is(chalito.publish_agent_links(jsonb_build_array(pg_temp.link('lnk_one12345', 'lk_a', 'lk_a'),
                                                        pg_temp.link('lnk_two12345', 'lk_a', 'lk_b'))), 2,
  'an agent publishes its links');
select throws_ok($$insert into chalito.agent_links (owner, device_id, link_id, mode, sender_device_id, receiver_device_id,
                    confirm, permission_ceiling, expires_at, details_ct)
                  values ('lk-user', 'lk_a', 'lnk_three123', 'handoff', 'lk_a', 'lk_a', false, 'default', now(), '{}')$$,
  '42501', null, 'no direct writes, only the RPC');
select throws_ok($$select chalito.publish_agent_links(jsonb_build_array(pg_temp.link('lnk_bad12345', 'lk_q', 'lk_r')))$$,
  '23514', null, 'a device publishes only links it is an end of');
select pg_temp.logout();

select pg_temp.as_device('lk-user', 'lk_phone', 'client');
select is((select count(*)::int from chalito.agent_links), 2, 'the owner''s client reads them');
select throws_ok($$select chalito.publish_agent_links('[]'::jsonb)$$, '42501', null, 'a client can''t publish links');
select pg_temp.logout();

select pg_temp.as_device('lk-other', 'lk_x', 'client');
select is((select count(*)::int from chalito.agent_links), 0, 'another account sees nothing');
select pg_temp.logout();

-- Revoke-all, as the api.
set local role chalito_server;
select is(chalito_private.revoke_agent_links('lk-user', 'revoke_all'), 2, 'revoke-all marks every link of the account');
reset role;

-- The agent republishes the same links: they stay revoked.
select pg_temp.as_device('lk-user', 'lk_a', 'agent');
select is(chalito.publish_agent_links(jsonb_build_array(pg_temp.link('lnk_one12345', 'lk_a', 'lk_a'))), 1, 'republished');
select pg_temp.logout();
select is((select count(*)::int from chalito.agent_links where owner = 'lk-user' and revoked_at is null), 0,
  'a revoked link is never un-revoked by the agent');
select is((select revoked_by from chalito.agent_links where link_id = 'lnk_two12345'), 'revoke_all',
  'a link the agent no longer sends keeps its revoke-all mark');

-- A link whose publish failed had no row for revoke-all to mark: made before it, it arrives
-- revoked however late it's published; one made after it is active.
select pg_temp.as_device('lk-user', 'lk_a', 'agent');
select is(chalito.publish_agent_links(jsonb_build_array(
  pg_temp.link('lnk_late1234', 'lk_a', 'lk_a', now() - interval '1 hour'),
  pg_temp.link('lnk_new12345', 'lk_a', 'lk_a', now() + interval '1 second'))), 2, 'late links published');
select pg_temp.logout();
select is((select revoked_by from chalito.agent_links where link_id = 'lnk_late1234'), 'revoke_all',
  'a link made before the revoke-all and first published after it is revoked');
select is((select revoked_at from chalito.agent_links where link_id = 'lnk_new12345'), null,
  'a link made after the revoke-all is active');

select pg_temp.as_device('lk-user', 'lk_phone', 'client');
select throws_ok($$select chalito_private.revoke_agent_links('lk-user', 'x')$$, '42501', null,
  'only the server revokes through the mirror');
select pg_temp.logout();

select * from finish();
rollback;
