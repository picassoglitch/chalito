-- Beta security review proofs (docs/reviews/beta-security-review.md): every assertion FAILS on
-- origin/all b026abf until R-H4 (forged role=user), R-L3 (cross-session plaintext card) and
-- R-M7 (anon realtime guard) are fixed.
begin;
set search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
select plan(4);
create function pg_temp.login(claims jsonb, topic text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (jsonb_build_object('role','authenticated','aud','authenticated') || claims)::text, true);
  perform set_config('realtime.topic', coalesce(topic, ''), true);
  set local role authenticated;
end $$;
insert into chalito.tenants (id) values ('rv-user');
insert into chalito.users (id, tenant_id) values ('rv-user', 'rv-user');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id) values
  ('rv-user','rv_a1','agent','desktop','linux','A1','ps','pb','fp','pairing', md5('rv_a1')::uuid),
  ('rv-user','rv_a2','agent','laptop','macos','A2','ps','pb','fp','pairing', md5('rv_a2')::uuid);
insert into chalito.sessions (owner, sid, device_id) values ('rv-user','rv_s2','rv_a2');
insert into chalito.mcp_sharing (owner, scope, target, enabled, plaintext_ack_at) values ('rv-user','device','rv_a1',true,now());

-- F1: app_metadata role 'user' must be bound to sub (only a hub session with no chalito claims is a user)
select pg_temp.login('{"sub":"00000000-0000-0000-0000-0000000000aa","app_metadata":{"chalito":{"owner":"rv-user","role":"user"}}}');
select is(chalito.jwt_role(), null, 'F1: app_metadata.chalito.role=user is not a user session');
select is((select count(*)::int from chalito.devices), 0, 'F1: forged user claim reads no devices of another owner');
reset role;

-- F3: an agent can't write the plaintext card of another agent's session
select pg_temp.login(jsonb_build_object('sub', md5('rv_a1')::uuid, 'app_metadata',
  '{"chalito":{"owner":"rv-user","device_id":"rv_a1","role":"agent"}}'::jsonb));
select throws_ok($$insert into chalito.session_card_plain (owner, sid, device_id, card)
  values ('rv-user','rv_s2','rv_a1','{"title":"forged"}')$$, '42501', null,
  'F3: session_card_plain insert requires the writer to own the session');
reset role;

-- F2: the chalito restrictive guard must not break anon on non-chalito topics
grant select on realtime.messages to anon;
create policy hub_anon_read on realtime.messages for select to anon using (true);
insert into realtime.messages (topic, payload) values ('public:lobby', '{}');
set local role anon;
select set_config('realtime.topic', 'public:lobby', true);
select lives_ok($$select count(*) from realtime.messages where topic = 'public:lobby'$$,
  'F2: anon can still read a non-chalito topic');
reset role;
select * from finish();
rollback;
