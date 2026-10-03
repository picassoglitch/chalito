# ADR 0005: Voice provider abstraction

- Status: Accepted (M0); implemented in M6/M7

## Verified context (2026-10-03)
- `gpt-realtime-2.1-mini` exists on `/v1/realtime` (128k context). Price per 1M tokens: $10 audio in, $0.30 cached, $20 audio out. That is roughly $0.006/min of user audio and $0.024/min of model audio before context re-billing (derived).
- **Ephemeral credentials:** `POST /v1/realtime/client_secrets` returns `ek_…` with a TTL from 10 s to 2 h (default 600 s), bound to a session config and an `OpenAI-Safety-Identifier`.
- **WebRTC:** `POST /v1/realtime/calls` with the SDP (ephemeral key), data channel `oai-events`.
- **SIP:** a trunk to `sip:<proj_id>@sip.api.openai.com;transport=tls`. A project webhook `realtime.call.incoming` (signed) is answered with `/v1/realtime/calls/{id}/accept|reject|refer|hangup`.
- OpenAI now leads with **GPT-Live** (`gpt-live-1`, `/v1/live/sessions`, $0.05/min + backend), with its own SIP event `live.transport.incoming`.

## Decision
- Define one interface in `packages/adapters/voice`:
  `VoiceProvider { mintClientCredential(sessionCfg) ; sipAccept(callId, cfg) ; sipReject ; sipHangup ; verifyWebhook(req) ; pricingRef }`.
  - Beta implementation: **OpenAI Realtime `gpt-realtime-2.1-mini`**. The model name lives in `models.yaml` (`voice.desktop`, `voice.call`).
  - A `gpt-live-1` adapter is a drop-in candidate later (the brief names Realtime, so we keep it).
- **Desktop push-to-talk:**
  - `api` mints an ephemeral key (TTL 60 s to connect; the session itself lasts longer) with the companion persona, tools (`route_to`, `open_approval`, `mesa_say`, `snooze`, `room_say`) and voice.
  - The desktop connects over WebRTC directly to OpenAI. Audio never transits our servers.
  - Tools return **short text commands** to sessions and never stream audio to them.
- **Calls:** Twilio → SIP to OpenAI (verification in comms §, see ADR 0011). When the user presses **1**, the call is bridged to a Realtime session that is accepted with:
  - the briefing context: metadata plus callLines if enabled;
  - tools `answer_item(sessionRef, text)` (produces a `call:<CallSid>` RelayedCommand) and `push_approval(aid)`.
  - There is **no tool that produces a Decision.**
- Usage (minutes/tokens) is metered into `usage_events` with `purpose=comms`.

## Consequences
- The ephemeral key is the only credential the client ever sees. The standard key stays in Secret Manager (`OPENAI_API_KEY`, `api` and `notifier` only).
- Voice is managed-only in beta (the brief has no BYO voice). It is metered against credits; on `free_min` voice is paused with an in-character line.
