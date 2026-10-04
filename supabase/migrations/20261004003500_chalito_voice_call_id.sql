-- Desktop voice through the api's SDP proxy: the api connects the WebRTC call itself (OpenAI's
-- unified POST /v1/realtime/calls) and keeps the provider's call id, so it can hang the call up
-- server-side at the voice cap, at the session's maximum, on revoke, and from the stale sweep.
-- Billing is unchanged: the api's clock from mint (migration 20261004003010).
alter table chalito_private.voice_sessions
  add column call_id text check (call_id is null or call_id ~ '^[A-Za-z0-9_-]{1,128}$');
create index voice_sessions_call_id on chalito_private.voice_sessions (call_id) where call_id is not null;
