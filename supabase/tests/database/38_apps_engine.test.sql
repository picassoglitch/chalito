-- Migration 20261006000300: connect engine (app ids in connections, AppConnectionDoc, session kind/app id).
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into chalito.tenants (id) values ('ae-user');
insert into chalito.users (id, tenant_id) values ('ae-user', 'ae-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
values ('ae-user', 'ae_agent', 'agent', 'laptop', 'linux', 'Laptop', 'p', 'p', 'f', 'pairing');

create function pg_temp.ok(doc text) returns boolean language sql as $$
  select chalito_private.valid_connection_doc(doc::jsonb) $$;

-- The status doc.
select ok(pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1790000000000,
  "kind": "web-app", "custom": false}'),
  'an app doc: a web app is available');
select ok(pg_temp.ok('{"mode": null, "connected": false, "state": "error",
  "cli": {"installed": false, "version": null}, "error": "recipe_disabled", "at": 1,
  "kind": "terminal", "custom": true, "name": "Mi agente"}'),
  'a custom recipe carries its own name');
select ok(pg_temp.ok('{"mode": "signin", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "0.160.1"}, "error": null, "at": 1790000000000}'),
  'provider docs stay valid');
select ok(pg_temp.ok('{"mode": "byo_api_key", "connected": true}'), 'the oldest docs stay valid');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "web-app", "custom": false,
  "name": "ChatGPT"}'),
  'a curated app never uploads a name');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "web-app"}'),
  'kind comes with custom');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "browser", "custom": false}'),
  'kinds are closed');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1}'),
  'the new state needs an app doc');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "error",
  "cli": {"installed": true, "version": null}, "error": "launch failed at /home/me", "at": 1,
  "kind": "desktop-app", "custom": false}'),
  'errors are still closed codes');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null, "path": "/Applications/X.app"}, "error": null, "at": 1,
  "kind": "desktop-app", "custom": false}'),
  'still never a path');
select ok(not pg_temp.ok('{"mode": null, "connected": false, "state": "available",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1, "kind": "terminal", "custom": true,
  "commands": ["rm -rf /"]}'),
  'a custom recipe never uploads more than id, name and status');

-- connections.provider is an app id.
select lives_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('ae-user', 'ae_agent', 'lm-studio', '{"mode": null, "connected": false, "state": "not_installed",
  "cli": {"installed": false, "version": null}, "error": null, "at": 1, "kind": "desktop-app", "custom": false}')$$,
  'any recipe id is a provider');
select lives_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('ae-user', 'ae_agent', 'anthropic', '{"mode": "api_key", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "2.1.291"}, "error": null, "at": 1}')$$,
  'an agent that has not updated can still write its old provider name');
select throws_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('ae-user', 'ae_agent', 'Not An Id!', '{"mode": "byo_api_key", "connected": false}')$$,
  '23514', null, 'provider must be an app id');

-- sessions.kind / app_id.
insert into chalito.sessions (owner, sid, device_id, doc)
values ('ae-user', 's_old', 'ae_agent', '{"adapter": "codex"}'),
       ('ae-user', 's_new', 'ae_agent', '{"adapter": "grok", "appId": "goose", "kind": "agent"}');
select results_eq($$select kind, app_id from chalito.sessions where owner = 'ae-user' order by sid$$,
  $$values ('agent'::text, 'goose'::text), ('agent'::text, 'codex'::text)$$,
  'old rows are agent sessions of their adapter''s app; new rows say theirs');
select throws_ok($$insert into chalito.sessions (owner, sid, device_id, doc)
  values ('ae-user', 's_bad', 'ae_agent', '{"kind": "shell"}')$$,
  '23514', null, 'session kinds are closed');
select throws_ok($$insert into chalito.sessions (owner, sid, device_id, doc)
  values ('ae-user', 's_bad2', 'ae_agent', '{"kind": "terminal", "appId": "../etc"}')$$,
  '23514', null, 'app ids are recipe ids');

select * from finish();
rollback;
