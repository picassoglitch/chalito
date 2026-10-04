-- Single-use marker for voice call refs (ADR 0005/0011): the X-Chalito-Ref that ties an
-- OpenAI SIP call to its Twilio call is accepted once, across every notifier instance.
create table chalito_private.voice_call_refs (
  -- sha256 of the ref (the ref itself never needs storing).
  ref_hash text primary key check (ref_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index voice_call_refs_expires_idx on chalito_private.voice_call_refs (expires_at);

alter table chalito_private.voice_call_refs enable row level security;
revoke all on chalito_private.voice_call_refs from public, anon, authenticated, service_role;
grant select, insert on chalito_private.voice_call_refs to chalito_server;
create policy server_all on chalito_private.voice_call_refs for all to chalito_server using (true) with check (true);

select cron.schedule(
  'chalito-voice-call-refs-purge',
  '*/10 * * * *',
  $$delete from chalito_private.voice_call_refs where expires_at < now() - interval '1 hour'$$
);
