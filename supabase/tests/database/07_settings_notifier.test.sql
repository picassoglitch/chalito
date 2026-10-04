-- Settings RPC (phone rule), companions RPC, connections, notifier tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

grant usage on schema extensions to chalito_server;

create function pg_temp.login(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated', 'aud', 'authenticated') || claims)::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
    'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))) $$;
create function pg_temp.as_user(owner text) returns void language sql as $$
  select pg_temp.login(jsonb_build_object('sub', owner, 'app_metadata', '{"provider": "email"}'::jsonb)) $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.count(q text) returns integer language plpgsql as $$
declare n integer;
begin
  execute format('select count(*) from (%s) as q', q) into n;
  return n;
end $$;

insert into chalito.tenants (id) values ('st-user'), ('st-other');
insert into chalito.users (id, tenant_id) values ('st-user', 'st-user'), ('st-other', 'st-other');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('st-user', 'st_phone', 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', md5('st_phone')::uuid),
  ('st-user', 'st_agent', 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', md5('st_agent')::uuid),
  ('st-user', 'st_agent2', 'agent', 'laptop', 'macos', 'Lap', 'p', 'p', 'f', 'pairing', md5('st_agent2')::uuid);

-- ================================================================ settings RPC
select pg_temp.as_device('st-user', 'st_phone', 'client');
select is((chalito.update_my_settings('{"locale": "en", "tz": "America/Mexico_City", "render_quality": "alto",
  "quiet_hours": {"start": "23:00", "end": "07:00"}, "l4_quiet_override": ["approval"],
  "prefs": {"onboarded_at": 1790000000000}, "phone_pending_e164": "+525512345678"}'))
  - array['phone_e164', 'phone_country', 'phone_verified_at', 'charges_notice_ack_at', 'call_briefing', 'privacy_mode',
          'whatsapp_opt_in', 'calls_enabled', 'sms_enabled'],
  '{"locale": "en", "tz": "America/Mexico_City", "render_quality": "alto", "quiet_hours": {"start": "23:00", "end": "07:00"},
    "l4_quiet_override": ["approval"], "prefs": {"onboarded_at": 1790000000000}, "phone_pending_e164": "+525512345678"}'::jsonb,
  'settings: a client device updates its owner''s settings and gets them back');
select is(chalito.get_my_settings() -> 'quiet_hours', '{"start": "23:00", "end": "07:00"}'::jsonb, 'settings: read back');
select lives_ok($$select chalito.update_my_settings('{"quiet_hours": {"off": true}}')$$, 'settings: quiet hours off');
select lives_ok($$select chalito.update_my_settings('{"quiet_hours": null}')$$, 'settings: quiet hours default (null)');
select throws_ok($$select chalito.update_my_settings('{"quiet_hours": {"start": "25:00", "end": "07:00"}}')$$, '22023', null,
  'settings: a bad quiet-hours window is refused');
select throws_ok($$select chalito.update_my_settings('{"phone_e164": "+525512345678"}')$$, '22023', null,
  'settings: the verified phone is not a client setting');
select throws_ok($$select chalito.update_my_settings('{"phone_verified_at": "2026-10-04"}')$$, '22023', null,
  'settings: nor is the verification time');
select throws_ok($$select chalito.update_my_settings('{"tz": "Mars/Olympus"}')$$, '22023', null, 'settings: unknown time zones are refused');
select throws_ok($$select chalito.update_my_settings('{"phone_pending_e164": "5512345678"}')$$, '23514', null,
  'settings: the pending phone must be E.164');
select throws_ok($$select chalito.update_my_settings('{"calls_enabled": true}')$$, '42501', null,
  'phone rule: clients can''t turn calls on (the api does, after its checks)');
select throws_ok($$update chalito.users set locale = 'en' where id = 'st-user'$$, '42501', null,
  'settings: no direct update of users');
select throws_ok($$select phone_pending_e164 from chalito.users$$, '42501', null,
  'phone: phone columns aren''t readable through the table');
select is(pg_temp.count($$select 1 from chalito.users where id = 'st-user'$$), 1, 'phone: the rest of the row still is');

select pg_temp.logout();
set local role chalito_server;
select lives_ok($$update chalito.users set phone_e164 = '+525512345678', phone_country = 'MX', phone_verified_at = now()
  where id = 'st-user'$$, 'phone: the server records the verified number after Twilio Verify');
select throws_ok($$update chalito.users set phone_e164 = '+525512345678', phone_verified_at = now() where id = 'st-other'$$,
  '23505', null, 'phone: two accounts can''t verify the same number');
select throws_ok($$update chalito.users set whatsapp_opt_in = true where id = 'st-user'$$, '23514', null,
  'phone rule: even the server can''t opt in before the charges notice is acknowledged (CHECK)');
reset role;

select pg_temp.as_device('st-user', 'st_phone', 'client');
select throws_ok($$select chalito.update_my_settings('{"whatsapp_opt_in": true}')$$, '42501', null,
  'phone rule: nor WhatsApp, verified or not');
select ok((chalito.update_my_settings('{"charges_notice_ack_at": true}') ->> 'charges_notice_ack_at') is not null,
  'phone rule: the ack is stamped with server time');
select throws_ok($$select chalito.update_my_settings('{"whatsapp_opt_in": true, "calls_enabled": true, "sms_enabled": null}')$$,
  '42501', null, 'phone rule: clients never turn opt-ins on, the api does (/v1/phone/channels)');
select pg_temp.logout();
set local role chalito_server;
select lives_ok($$update chalito.users set whatsapp_opt_in = true, calls_enabled = true where id = 'st-user'$$,
  'phone rule: then the api''s opt-ins are accepted');
reset role;
select pg_temp.as_device('st-user', 'st_phone', 'client');
select lives_ok($$select chalito.update_my_settings('{"calls_enabled": false}')$$, 'phone rule: clients may turn them off');
select is((chalito.get_my_settings() ->> 'calls_enabled')::boolean, false, 'phone rule: and it sticks');
select is(chalito.get_my_settings() ->> 'phone_e164', '+525512345678', 'phone: the owner reads it through the RPC');

select pg_temp.as_user('st-user');
select is(chalito.get_my_settings() ->> 'phone_country', 'MX', 'settings: the person''s web session reads them too');
select pg_temp.as_device('st-user', 'st_agent', 'agent');
select throws_ok($$select chalito.get_my_settings()$$, '42501', null, 'settings: agents can''t read settings (phone)');
select throws_ok($$select chalito.update_my_settings('{"locale": "es"}')$$, '42501', null, 'settings: nor change them');
select pg_temp.logout();

-- ================================================================ companions
select pg_temp.as_device('st-user', 'st_phone', 'client');
select ok((chalito.create_my_companion('Chalito', 'starter_owl') ->> 'companion_id') ~ '^chl_[a-z2-7]{26}$',
  'companions: onboarding creates one with a server-minted chl_ id');
select throws_ok($$select chalito.create_my_companion('Otro', 'starter_cat')$$, '23505', null, 'companions: only one per owner');
select throws_ok($$update chalito.companions set equipped = '{"head": "hat"}'$$, '42501', null, 'companions: equipping stays server only');
select is(pg_temp.count($$select 1 from chalito.companions where avatar = 'starter_owl'$$), 1, 'companions: the avatar is recorded');
select lives_ok($$update chalito.companions set avatar = 'starter_cat'$$, 'companions: the owner can change the avatar');
select throws_ok($$update chalito.companions set avatar = 'Not An Id!'$$, '23514', null, 'companions: still a roster-shaped id');
select pg_temp.as_user('st-other');
select throws_ok($$select chalito.create_my_companion('X', 'Not An Id!')$$, '23514', null, 'companions: avatar must be a roster id');
select pg_temp.logout();

-- ================================================================ connections
select pg_temp.as_device('st-user', 'st_agent', 'agent');
select lives_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('st-user', 'st_agent', 'anthropic', '{"mode": "byo_api_key", "connected": true}')$$,
  'connections: the agent reports its own connection status');
select throws_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('st-user', 'st_agent2', 'openai', '{"mode": "byo_api_key", "connected": true}')$$, '42501', null,
  'connections: not another device''s');
select throws_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('st-user', 'st_agent', 'openai', '{"mode": "byo_api_key", "connected": true, "apiKey": "sk-..."}')$$, '23514', null,
  'connections: status only, never a secret');
select pg_temp.as_device('st-user', 'st_phone', 'client');
select is(pg_temp.count($$select 1 from chalito.connections$$), 1, 'connections: members read them');
select throws_ok($$insert into chalito.connections (owner, device_id, provider, doc)
  values ('st-user', 'st_phone', 'xai', '{"mode": "managed", "connected": false}')$$, '42501', null,
  'connections: clients don''t write them');
select pg_temp.logout();

-- ================================================================ notifier
select pg_temp.as_device('st-user', 'st_phone', 'client');
select lives_ok($$insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
  values ('st-user', 'st_phone', 'https://push.example/1', 'k', 'a')$$, 'push: the client registers its own subscription');
select throws_ok($$insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
  values ('st-user', 'st_agent', 'https://push.example/2', 'k', 'a')$$, '42501', null, 'push: not for another device');
select throws_ok($$insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
  values ('st-user', 'st_phone', 'http://push.example/3', 'k', 'a')$$, '23514', null, 'push: https endpoints only');
select throws_ok($$select p256dh from chalito.push_subscriptions$$, '42501', null, 'push: the keys aren''t read back');
select lives_ok($o$ do $t$ begin for i in 2..5 loop
  insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
  values ('st-user', 'st_phone', 'https://push.example/' || i, 'k', 'a'); end loop; end $t$ $o$, 'push: up to 5 per device');
select throws_ok($$insert into chalito.push_subscriptions (owner, device_id, endpoint, p256dh, auth)
  values ('st-user', 'st_phone', 'https://push.example/6', 'k', 'a')$$, 'PT429', null, 'push: a sixth is refused');
select throws_ok($$select * from chalito_private.notification_ladders$$, '42501', null, 'ladders: server only');
select pg_temp.logout();

set local role chalito_server;
select lives_ok($$insert into chalito_private.notification_ladders (owner, coalesce_key, nid, state, ladder)
  values ('st-user', 'approvals', 'n1', 'done', '{"step": 3}')$$, 'ladders: the notifier writes ladder state (incl. done)');
select lives_ok($$insert into chalito_private.notification_sends (owner, nid, coalesce_key, channel, status)
  values ('st-user', 'n1', 'approvals', 'whatsapp', 'queued')$$, 'sends: and send history');
select is(pg_temp.count($$select 1 from chalito.push_subscriptions where owner = 'st-user'$$), 5, 'push: the notifier reads subscriptions');
reset role;
set local role service_role;
select throws_ok($$select * from chalito.push_subscriptions$$, '42501', null, 'S2: the hub''s service_role reads none of it');
reset role;

select * from finish();
rollback;
