-- Migration 20261021002000 (ADR 0030): credentials are server-only, owners read their own cap and spend,
-- and chalito_ai_gateway writes only metering and coding usage events.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);
grant usage on schema extensions to chalito_server, chalito_ai_gateway;

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;

create function pg_temp.cred(id text, owner text, sid text, agent text, provider text) returns void language sql as $$
  insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at)
  values (id, encode(sha256(id::bytea), 'hex'), owner, 'cm_a_desk', sid, agent, provider, '{gpt-5.6-luna}', now() + interval '1 hour')
$$;

insert into chalito.tenants (id) values ('cm-a'), ('cm-b');
insert into chalito.users (id, tenant_id, tier, tz) values ('cm-a', 'cm-a', 'Pro', 'America/Mexico_City'), ('cm-b', 'cm-b', 'VIP', null);
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values
  ('cm-a', 'cm_a_phone', 'client', 'phone', 'ios', 'Phone', 'pk', 'p', 'f', 'first_client', md5('cm_a_phone')::uuid, false),
  ('cm-a', 'cm_a_old', 'client', 'web', 'web', 'Old', 'pk', 'p', 'f', 'endorsement', md5('cm_a_old')::uuid, true),
  ('cm-a', 'cm_a_desk', 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', md5('cm_a_desk')::uuid, false),
  ('cm-b', 'cm_b_phone', 'client', 'phone', 'ios', 'Phone', 'pk', 'p', 'f', 'first_client', md5('cm_b_phone')::uuid, false);

select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('chalito_private.coding_credentials'::regclass, 'chalito.coding_settings'::regclass, 'chalito.coding_spend_daily'::regclass)),
  'RLS is on for all three tables');

-- ================================================================ the api (chalito_server)
set local role chalito_server;
select lives_ok($$select pg_temp.cred('cc_00000000000000000000000000000001', 'cm-a', 'cm_s1', 'codex', 'openai')$$,
  'the api issues a credential');
select throws_ok($$select pg_temp.cred('cc_00000000000000000000000000000002', 'cm-a', 'cm_s1', 'codex', 'openai')$$,
  '23505', null, 'one live credential per (owner, device, session, agent)');
select lives_ok($$select pg_temp.cred('cc_00000000000000000000000000000003', 'cm-a', 'cm_s1', 'grok-build', 'xai')$$,
  'another agent in the same session gets its own');
select throws_ok($$select pg_temp.cred('cc_00000000000000000000000000000004', 'cm-a', 'cm_s2', 'codex', 'xai')$$,
  '23514', null, 'an agent is bound to its own provider');
select throws_ok($$select pg_temp.cred('cc_00000000000000000000000000000005', 'cm-a', 'cm_s2', 'claude-code', 'anthropic')$$,
  '23514', null, 'Claude Code can never have a managed credential');
select throws_ok($$select pg_temp.cred('not-an-id', 'cm-a', 'cm_s2', 'codex', 'openai')$$,
  '23514', null, 'ids are cc_ + 32 hex');
select throws_ok($$update chalito_private.coding_credentials set revoked_at = now() where id = 'cc_00000000000000000000000000000001'$$,
  '23514', null, 'a revocation always says why');
update chalito_private.coding_credentials set revoked_at = now(), revoked_reason = 'reissued'
  where id = 'cc_00000000000000000000000000000001';
select lives_ok($$select pg_temp.cred('cc_00000000000000000000000000000006', 'cm-a', 'cm_s1', 'codex', 'openai')$$,
  'once revoked, the session can get a new one');
select lives_ok($$insert into chalito.coding_settings (owner, daily_cap_tokens) values ('cm-a', 1000000)$$,
  'the api stores the owner''s cap');
select throws_ok($$insert into chalito.coding_settings (owner, daily_cap_tokens) values ('cm-b', -1)$$,
  '23514', null, 'a cap is never negative');
select throws_ok($$insert into chalito.coding_settings (owner, cap_tz_next) values ('cm-b', 'Asia/Tokyo')$$,
  '23514', null, 'a pending cap zone always says when it starts');
select throws_ok($$insert into chalito.coding_spend_daily (owner, day, agent) values ('cm-a', current_date, 'codex')$$,
  '42501', null, 'the api never writes spend (only the gateway meters)');

-- ================================================================ the gateway (chalito_ai_gateway)
set local role chalito_ai_gateway;
select is((select count(*)::int from chalito_private.coding_credentials), 3, 'the gateway reads credentials');
select lives_ok($$update chalito_private.coding_credentials
  set inflight_micros = 10, inflight_requests = 1, spent_micros = 20, requests = 1, hold_gen = 1, blocked_reason = 'daily_cap',
      reservation_id = gen_random_uuid(), settled_at = now()
  where id = 'cc_00000000000000000000000000000006'$$, 'the gateway updates the metering columns');
select throws_ok($$update chalito_private.coding_credentials set models = '{grok-4.7}'$$,
  '42501', null, 'the gateway can''t widen a model allowlist');
select throws_ok($$update chalito_private.coding_credentials set expires_at = now() + interval '1 year'$$,
  '42501', null, 'the gateway can''t extend a credential');
select throws_ok($$update chalito_private.coding_credentials set token_hash = repeat('0', 64)$$,
  '42501', null, 'the gateway can''t change a token');
select throws_ok($$select pg_temp.cred('cc_00000000000000000000000000000007', 'cm-a', 'cm_s3', 'codex', 'openai')$$,
  '42501', null, 'the gateway can''t issue credentials');
select lives_ok($$insert into chalito_private.usage_outbox (owner, source_id, event) values ('cm-a', 'coding:cc_x:1',
  '{"source_id": "coding:cc_x:1", "cost_usd_micros": 5}')$$, 'the gateway writes coding usage events');
select throws_ok($$insert into chalito_private.usage_outbox (owner, source_id, event) values ('cm-a', 'voice_x:1',
  '{"source_id": "voice_x:1", "cost_usd_micros": 5}')$$, '42501', null, 'and nothing else');
select lives_ok($$insert into chalito.coding_spend_daily (owner, day, agent, cost_usd_micros, billable_tokens, requests)
  values ('cm-a', current_date, 'codex', 5, 4, 1)
  on conflict (owner, day, agent) do update set cost_usd_micros = coding_spend_daily.cost_usd_micros + 5$$,
  'the gateway adds to the day''s spend');
select throws_ok($$update chalito.coding_settings set daily_cap_tokens = 1$$, '42501', null, 'the gateway never changes a cap');
select is((select tier from chalito.users where id = 'cm-a'), 'Pro', 'the gateway reads the tier');
select throws_ok($$select email from chalito.users$$, '42501', null, 'but not the rest of the user');
select is((select revoked from chalito.devices where device_id = 'cm_a_desk'), false, 'and whether the device is revoked');

-- ================================================================ the owner's devices
reset role;
insert into chalito_private.usage_outbox (owner, source_id, event)
  values ('cm-a', 'voice_y:1', '{"source_id": "voice_y:1", "cost_usd_micros": 5}');
set local role chalito_ai_gateway;
select is((select count(*)::int from chalito_private.usage_outbox where owner = 'cm-a'), 1,
  'the gateway sees only coding usage events');

select pg_temp.as_device('cm-a', 'cm_a_phone', 'client');
select is((select daily_cap_tokens from chalito.coding_settings), 1000000::bigint, 'the owner reads the cap');
select is((select requests from chalito.coding_spend_daily), 1, 'and the day''s spend');
select throws_ok($$select 1 from chalito_private.coding_credentials$$, '42501', null, 'never a credential');
select throws_ok($$update chalito.coding_settings set daily_cap_tokens = 99999999$$, '42501', null,
  'a client can''t raise the cap directly (the api checks the passkey)');
select pg_temp.as_device('cm-a', 'cm_a_old', 'client');
select is((select count(*)::int from chalito.coding_settings), 0, 'a revoked device sees nothing');
select pg_temp.as_device('cm-b', 'cm_b_phone', 'client');
select is((select count(*)::int from chalito.coding_spend_daily) + (select count(*)::int from chalito.coding_settings), 0,
  'another owner sees nothing');

-- ================================================================ the chalyb connect method
select ok(chalito_private.valid_connection_doc('{"mode": "chalyb", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": "0.163.0"}, "error": null, "at": 1}'), 'a connection doc may say chalyb');
select ok(not chalito_private.valid_connection_doc('{"mode": "ours", "connected": true, "state": "connected",
  "cli": {"installed": true, "version": null}, "error": null, "at": 1}'), 'but no other new mode');

-- ================================================================ account deletion
reset role;
delete from chalito.users where id = 'cm-a';
select is((select count(*)::int from chalito_private.coding_credentials where owner = 'cm-a'), 0, 'credentials go with the account');
select is((select count(*)::int from chalito.coding_spend_daily where owner = 'cm-a'), 0, 'and so does the spend');

select * from finish();
rollback;
