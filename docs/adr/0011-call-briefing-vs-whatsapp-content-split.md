# ADR 0011: Call briefing vs WhatsApp/SMS content split

- Status: Accepted (M0); implemented in M6

## Principle
- **Persistent channels carry no content:** WhatsApp, SMS, push previews and email.
- **Ephemeral voice may carry one short line per waiting item, only by explicit opt-in.**
- **No channel other than the paired app can approve anything.**

## WhatsApp (Cloud API, direct; Graph API **v26.0**)
- Utility templates `chalito_*` (ES `es_MX`, EN `en_US`) live as JSON in `apps/notifier/templates/`. Submission to Meta is a manual OPS step.
- Example `chalito_pendientes_v1`: "Chalito: tienes {{1}} pendientes en tu cuenta ({{2}}). Urgencia: {{3}}. Ábrelos en la app." The URL button suffix is an opaque notification id.
  - The fixed text is deliberately specific ("en tu cuenta", "Ábrelos en la app") so Meta classifies it as **utility (account alert)**. Mostly-variable bodies get recategorized as marketing.
- Variables come only from `OutboundTemplateVars`: `.strict()`, integers and enums. **A content leak is unrepresentable.**
- Inbound webhook: `X-Hub-Signature-256` HMAC-SHA256 of the raw body with the app secret. It records only acks, opt-outs and delivery statuses. Opt-out for utility traffic is our own quick reply ("Dejar de recibir"), because Meta's `user_preferences` covers marketing only.
- Cost: since 2026-10-01 utility messages are billed **even inside the 24 h window**. Mexico is USD 0.0085 per message. Metered as `usage_events.kind=whatsapp`. Unverified businesses are limited to 250 unique recipients per 24 h until Meta business verification.

## Calls (Twilio Programmable Voice)
- **Number:** a US local number ($1.15/mo) by default (owner decision #17). Caller ID into MX is "non-guaranteed". An MX local number ($6.25/mo) needs a regulatory bundle with a Mexican address.
- **Briefing:** built deterministically by `packages/escalation/briefing.ts` from `CallBriefing` (counts, types, urgency, device/session labels, Mesa title and time, unanswered counts) plus `callLines` when `callBriefing.enabled`.
  - Spoken with `<Say>`: `Polly.Mia-Neural` (es-MX) / `Polly.Joanna-Neural` (en-US). Voices live in config. Twilio has no Google es-MX voices.
- **Menu:** `<Gather input="dtmf speech" language="es-MX" numDigits="1" speechTimeout="auto" actionOnEmptyResult="true">`.
  - `speechModel` is unset because `phone_call`/`experimental_*` don't support es-MX. Setting a model forces an integer `speechTimeout`.
  - Options: **1** connect, **2** snooze (re-call at T-1 min for Mesas, else +10 min), **3** dismiss.
- **Connect = SIP to OpenAI Realtime** via `<Dial><Sip>sip:<proj>@sip.api.openai.com;transport=tls;secure=true</Sip></Dial>` (Programmable SIP; no Elastic SIP Trunking needed).
  - OpenAI fires `realtime.call.incoming` (signed). `notifier` accepts it with the briefing context and tools `answer_item`, `push_approval`.
  - **Fallback:** `<Connect><Stream>` bidirectional Media Streams (µ-law 8 kHz) bridged by `notifier` to a Realtime WebSocket. It is used if SIP proves unreliable in M6 (community reports of per-project gating).
- **Voice answers** become `RelayedCommand { origin: "call:<CallSid>", payload: session.prompt|session.answer }`. Local origin policy applies. They are never eligible for Developer-mode auto-approve.
  - **There is no code path from a call to a `Decision`.** The companion says "Esa aprobación necesita tu app; te la mandé" and pushes it.
- **Webhooks:** `X-Twilio-Signature` (HMAC-SHA1 over URL + sorted params with the auth token) is validated on every request.
- **Guards:**
  - Calls go only to the **verified** number on the account. Verification is by Twilio Verify OTP (SMS or call; $0.05 per success plus channel fees).
  - Destinations must be in Twilio Geo Permissions. An unsupported country gets a clear message and no call.
  - The "Pueden aplicar cargos" acknowledgement is stored before calls can be enabled.
  - Quiet hours and daily caps apply (calls 3, WhatsApp 10).
- `callLines` are deleted at call end and also TTL-expire.

## SMS fallback
Metadata only, like WhatsApp. US recipients need A2P 10DLC registration (OPS). To Mexico from a US number, the sender shows as a short code and it costs ~$0.18 per segment, about 21× WhatsApp. SMS is therefore the **last rung** and off by default for MX numbers.

## Web Push
- FCM `register()` / `onRegistered()` with Firebase Installation IDs. `getToken()` is deprecated, and HTTP v1 uses `fid`.
- iOS needs 16.4+ and a Home Screen install. Payloads are metadata only.
- Declarative Web Push via FCM is unverified, so the service worker is the baseline.
