-- Voice, metered on the server (R-H6, R-M8). Desktop push-to-talk talks to OpenAI directly, so
-- Chalito bills what it observes: the time since the api minted the session, capped per session,
-- not the seconds a client reports. Phone-call voice (the notifier) uses the same rows, bounded by
-- Twilio's timeLimit. One open session per owner and channel. A session that is never ended is billed
-- in full by the sweep (the notifier's drain task). Each increment's usage event is written in the
-- same transaction as billed_seconds, with source_id `<session>:<total>`, so retries never double-bill.
create table chalito_private.voice_sessions (
  source_id text primary key check (source_id ~ '^voice_[0-9a-f]{32}$'),
  owner chalito.id not null references chalito.users (id) on delete cascade,
  channel text not null default 'desktop' check (channel in ('desktop', 'call')),
  -- The desktop device, or the Twilio CallSid for a phone call.
  device_id chalito.id not null,
  reservation_id uuid not null,
  model text not null,
  started_at timestamptz not null,
  max_seconds integer not null check (max_seconds between 1 and 7200),
  billed_seconds integer not null default 0 check (billed_seconds between 0 and max_seconds),
  last_beat_at timestamptz,
  ended_at timestamptz,
  closed_by text check (closed_by in ('end', 'sweep'))
);
create unique index voice_sessions_one_open on chalito_private.voice_sessions (owner, channel) where ended_at is null;
create index voice_sessions_open_started on chalito_private.voice_sessions (started_at) where ended_at is null;

alter table chalito_private.voice_sessions enable row level security;
revoke all on chalito_private.voice_sessions from public, anon, authenticated, service_role;
grant select, insert, update on chalito_private.voice_sessions to chalito_server;
create policy server_all on chalito_private.voice_sessions for all to chalito_server using (true) with check (true);

select cron.schedule(
  'chalito-voice-sessions-purge',
  '17 3 * * *',
  $$delete from chalito_private.voice_sessions where ended_at < now() - interval '90 days'$$
);
