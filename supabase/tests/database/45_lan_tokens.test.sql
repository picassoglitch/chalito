-- Migration 20261015000500: LAN pairing tokens (ADR 0022 §5). Only an active agent device gets a
-- grant; two agents of one owner get the same token; the peers are the owner's other active agents
-- (never another owner's, never a revoked one, never a client); the table is server-only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create function pg_temp.as_device(owner text, device text, chalito_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aud', 'authenticated',
    'sub', md5(device)::uuid, 'app_metadata', jsonb_build_object(
      'chalito', jsonb_build_object('owner', owner, 'device_id', device, 'role', chalito_role)))::text, true);
  set local role authenticated;
end $$;

insert into chalito.tenants (id) values ('lan-a'), ('lan-b');
insert into chalito.users (id, tenant_id) values ('lan-a', 'lan-a'), ('lan-b', 'lan-b');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
values
  ('lan-a', 'lan_a_desk', 'agent', 'desktop', 'linux', 'Desk', 'pk_desk', 'p', 'f', 'pairing', md5('lan_a_desk')::uuid, false),
  ('lan-a', 'lan_a_laptop', 'agent', 'laptop', 'macos', 'Laptop', 'pk_laptop', 'p', 'f', 'pairing', md5('lan_a_laptop')::uuid, false),
  ('lan-a', 'lan_a_old', 'agent', 'laptop', 'linux', 'Old', 'pk_old', 'p', 'f', 'pairing', md5('lan_a_old')::uuid, true),
  ('lan-a', 'lan_a_phone', 'client', 'phone', 'ios', 'Phone', 'pk_phone', 'p', 'f', 'first_client', md5('lan_a_phone')::uuid, false),
  ('lan-b', 'lan_b_desk', 'agent', 'desktop', 'linux', 'Desk', 'pk_b', 'p', 'f', 'pairing', md5('lan_b_desk')::uuid, false);

create temp table g (who text, grant_ jsonb);
grant all on g to authenticated;

-- ================================================================ who may ask
select pg_temp.as_device('lan-a', 'lan_a_desk', 'agent');
select lives_ok($$insert into g select 'desk', chalito.lan_token()$$, 'an active agent gets a grant');
select pg_temp.as_device('lan-a', 'lan_a_laptop', 'agent');
select lives_ok($$insert into g select 'laptop', chalito.lan_token()$$, 'the owner''s other agent gets one too');
select pg_temp.as_device('lan-b', 'lan_b_desk', 'agent');
select lives_ok($$insert into g select 'b', chalito.lan_token()$$, 'another owner''s agent gets its own');

select pg_temp.as_device('lan-a', 'lan_a_phone', 'client');
select throws_ok($$select chalito.lan_token()$$, '42501', null, 'a client can''t get a LAN token');
select pg_temp.as_device('lan-a', 'lan_a_old', 'agent');
select throws_ok($$select chalito.lan_token()$$, '42501', null, 'a revoked agent can''t');
select pg_temp.as_device('lan-b', 'lan_a_desk', 'agent');
select throws_ok($$select chalito.lan_token()$$, '42501', null, 'claims for another owner''s device are refused');
select throws_ok($$select * from chalito_private.lan_tokens$$, '42501', null, 'the table is server-only');

reset role;
-- ================================================================ what they get
select is((select grant_ #>> '{tokens,0,tid}' from g where who = 'desk'),
          (select grant_ #>> '{tokens,0,tid}' from g where who = 'laptop'),
          'two agents of one owner share the token');
select isnt((select grant_ #>> '{tokens,0,tid}' from g where who = 'desk'),
            (select grant_ #>> '{tokens,0,tid}' from g where who = 'b'),
            'another owner has another token');
select ok((select grant_ #>> '{tokens,0,secret}' from g where who = 'desk') ~ '^[A-Za-z0-9_-]{43}$',
          'the secret is 32 bytes of unpadded base64url');
select ok((select (grant_ #>> '{tokens,0,expires_at}')::bigint from g where who = 'desk')
          <= (extract(epoch from now() + interval '15 minutes') * 1000)::bigint,
          'a token lives at most 15 minutes');
select is((select grant_ -> 'peers' from g where who = 'desk'),
          '[{"device_id": "lan_a_laptop", "pub_sign": "pk_laptop"}]'::jsonb,
          'peers: the owner''s other active agents only (no self, revoked agent, client or other owner)');
select is((select grant_ -> 'peers' from g where who = 'b'), '[]'::jsonb, 'an owner with one agent has no peers');

-- Rotation: when the newest token is near its end, a new one is minted and both are returned.
update chalito_private.lan_tokens set expires_at = now() + interval '2 minutes', issued_at = now() - interval '10 minutes'
  where owner = 'lan-a';
select pg_temp.as_device('lan-a', 'lan_a_desk', 'agent');
select is(jsonb_array_length(chalito.lan_token() -> 'tokens'), 2, 'a fresh token is minted next to the ending one');
reset role;
select throws_ok($$insert into chalito_private.lan_tokens (owner, tid, secret, expires_at)
  values ('lan-a', 'AAAAAAAAAAAAAAAAAAAAAA', extensions.gen_random_bytes(32), now() + interval '1 hour')$$,
  '23514', null, 'the table refuses a token longer than 15 minutes');
select pg_temp.as_device('lan-a', 'lan_a_desk', 'agent');
select throws_ok($$select chalito_private.b64url('\x00'::bytea)$$, '42501', null, 'helpers aren''t callable by clients');

select * from finish();
rollback;
