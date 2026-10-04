-- Migration 003600: removed members and revoked devices are told to leave their channels (R-L14);
-- member reports go to a server-only table, deduped per reporter and target.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

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
create function pg_temp.sent(p_topic text, p_op text) returns integer language sql as $$
  select count(*)::int from realtime.messages
  where topic = p_topic and payload ->> 'op' = p_op and inserted_at >= now() $$;
create function pg_temp.wrapped(devices text[]) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(d, repeat('k', 107)), '{}') from unnest(devices) d $$;

insert into chalito.tenants (id) values ('kr-dad'), ('kr-son'), ('kr-out');
insert into chalito.users (id, tenant_id) values ('kr-dad', 'kr-dad'), ('kr-son', 'kr-son'), ('kr-out', 'kr-out');
insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
values
  ('kr-dad', 'kr_dad_phone', 'client', 'phone', 'ios', 'P', 'p', 'p', 'f', 'first_client', md5('kr_dad_phone')::uuid),
  ('kr-son', 'kr_son_phone', 'client', 'phone', 'ios', 'S', 'p', 'p', 'f', 'first_client', md5('kr_son_phone')::uuid),
  ('kr-son', 'kr_son_agent', 'agent', 'desktop', 'linux', 'D', 'p', 'p', 'f', 'pairing', md5('kr_son_agent')::uuid),
  ('kr-out', 'kr_out_phone', 'client', 'phone', 'ios', 'O', 'p', 'p', 'f', 'first_client', md5('kr_out_phone')::uuid);
insert into chalito.companions (owner, companion_id, name) values
  ('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'Papá'), ('kr-son', 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'Hijo'),
  ('kr-out', 'chl_krcccccccccccccccccccccccc', 'Otro');

set local role chalito_server;
select chalito_private.room_create('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'family', 'Familia',
  pg_temp.wrapped(array['kr_dad_phone']), 5);
select chalito_private.room_invite('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'kr_inv1', repeat('e', 64), repeat('f', 64), 1,
  now() + interval '7 days');
select chalito_private.room_join('kr-son', 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', repeat('f', 64), 5);
reset role;
insert into chalito.room_events (room_id, eid, from_companion_id, kind, ct, key_epoch)
values ('kr_r1', 'kr_e1', 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'notice',
        jsonb_build_object('alg', 'xchacha20poly1305', 'nonce', repeat('n', 32), 'ct', 'opaque'), 1),
       ('kr_r1', 'kr_e2', 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'notice',
        jsonb_build_object('alg', 'xchacha20poly1305', 'nonce', repeat('n', 32), 'ct', 'opaque'), 1);

-- ---------------------------------------------------------------- reports
set local role chalito_server;
select is((select duplicate from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_1',
  'kr_e1', null, 'spam', 'molesta', null)), false, 'report: a member reports an event');
select is((select report_id || '/' || duplicate from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa',
  'kr_r1', 'rpt_2', 'kr_e1', null, 'abuse', null, null)), 'rpt_1/true', 'report: the same target again returns the first report');
select is((select member_companion_id from chalito_private.room_reports where report_id = 'rpt_1'),
  'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'report: an event report records its author as the member');
select is((select duplicate from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_3',
  null, 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'impersonation', null, null)), false, 'report: a member on its own is a separate target');
select throws_ok($$select * from chalito_private.room_report('kr-out', 'chl_krcccccccccccccccccccccccc', 'kr_r1', 'rpt_4',
  'kr_e1', null, 'spam', null, null)$$, '42501', null, 'report: only members of the room');
select throws_ok($$select * from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_5',
  'kr_nope', null, 'spam', null, null)$$, 'PT404', null, 'report: the event must exist in this room');
select throws_ok($$select * from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_6',
  null, 'chl_krcccccccccccccccccccccccc', 'spam', null, null)$$, 'PT404', null, 'report: the member must be in this room');
select throws_ok($$select * from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_7',
  null, 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'spam', null, null)$$, '22023', null, 'report: not yourself');
select throws_ok($$select * from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_8',
  'kr_e2', null, 'hate', null, null)$$, '23514', null, 'report: only the known reasons');
reset role;

select pg_temp.as_device('kr-dad', 'kr_dad_phone', 'client');
select throws_ok($$select * from chalito_private.room_reports$$, '42501', null, 'reports: clients can''t read them');
select throws_ok($$select * from chalito_private.room_report('kr-dad', 'chl_kraaaaaaaaaaaaaaaaaaaaaaaa', 'kr_r1', 'rpt_9',
  'kr_e1', null, 'spam', null, null)$$, '42501', null, 'reports: nor call the function directly (only the api)');
select pg_temp.logout();
set local role chalito_gateway;
select throws_ok($$select * from chalito_private.room_reports$$, '42501', null, 'reports: the MCP gateway can''t read them');
reset role;

-- ---------------------------------------------------------------- R-L14: kicks
set local role chalito_server;
select chalito_private.room_leave('kr-son', 'chl_krbbbbbbbbbbbbbbbbbbbbbbbb', 'kr_r1');
reset role;
select is(pg_temp.sent('chalito:room:kr_r1', 'kicked'), 1, 'kick: the room topic says who left');
select is(pg_temp.sent('chalito:device:kr_son_phone', 'kicked'), 1, 'kick: and the leaver''s client devices, on their own topics');
select is(pg_temp.sent('chalito:device:kr_son_agent', 'kicked'), 0, 'kick: not its agents (they never join rooms)');
select is((select payload -> 'key' from realtime.messages where topic = 'chalito:device:kr_son_phone' and payload ->> 'op' = 'kicked'
           order by inserted_at desc limit 1), '{"room_id": "kr_r1", "companion_id": "chl_krbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
  'kick: a pointer with ids only');

update chalito.devices set revoked = true where device_id = 'kr_son_phone';
select is(pg_temp.sent('chalito:device:kr_son_phone', 'revoked'), 1, 'revoke: the revoked device itself is told on its topic');
update chalito.devices set name = 'renamed' where device_id = 'kr_son_phone';
select is(pg_temp.sent('chalito:device:kr_son_phone', 'revoked'), 1, 'revoke: only once, on the change');

select * from finish();
rollback;
