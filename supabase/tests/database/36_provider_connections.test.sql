-- Migration 20261006000100: the agent's per-provider status doc (ProviderConnectionDoc).
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into chalito.tenants (id) values ('pc-user');
insert into chalito.users (id, tenant_id) values ('pc-user', 'pc-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('pc-user', 'pc_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing');

create function pg_temp.ok(doc text) returns boolean language sql as $$
  select chalito_private.valid_connection_doc(doc::jsonb) $$;

select ok(pg_temp.ok('{"mode": "signin", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "0.160.1"}, "error": null, "at": 1790000000000}'),
  'the contract shape is valid');
select ok(pg_temp.ok('{"mode": null, "connected": false, "state": "not_installed",
  "cli": {"installed": false, "version": null}, "error": "install_failed", "at": 1790000000000}'),
  'not installed, with a closed error code');
select ok(pg_temp.ok('{"mode": "byo_api_key", "connected": true}'), 'rows from earlier agents stay valid');
select ok(not pg_temp.ok('{"mode": "api_key", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "1"}, "error": null, "at": 1, "key": "sk-x"}'),
  'never a secret');
select ok(not pg_temp.ok('{"mode": "api_key", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "1", "path": "/home/me/bin/codex"}, "error": null, "at": 1}'),
  'never a path');
select ok(not pg_temp.ok('{"mode": "api_key", "connected": false, "state": "error",
  "cli": {"installed": true, "version": "1"}, "error": "EACCES /home/me", "at": 1}'),
  'errors are closed codes');
select ok(not pg_temp.ok('{"mode": "api_key", "connected": true, "state": "needs_auth",
  "cli": {"installed": true, "version": "1"}, "error": null, "at": 1}'),
  'connected matches the state');
select lives_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('pc-user', 'pc_agent', 'google', '{"mode": "signin", "connected": false, "state": "signing_in",
  "cli": {"installed": true, "version": "0.62.0"}, "error": null, "at": 1790000000000}')$$,
  'the table accepts the new shape');

select * from finish();
rollback;
