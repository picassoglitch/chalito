# notifier

Cloud Run service that turns notifications into escalation ladders (brief §5 M6, ADR 0011).
It runs `decide()` from `@chalito/escalation` and carries out the result:

- desktop: through the `chalito.notifications` row (Realtime broadcast);
- push: Web Push with VAPID (D-050);
- WhatsApp: a utility template;
- calls: Twilio, with a spoken briefing;
- SMS: the last rung.

Persistent channels carry no content. Nothing here can approve anything.

## Endpoints

| Route | Caller | Auth |
|---|---|---|
| `POST /pubsub/notifications` | Pub/Sub push, topic `notifications` | Google OIDC: audience = this URL, email = `PUBSUB_SA_EMAIL` |
| `POST /pubsub/room-events` | Pub/Sub push, topic `room-events` | same, audience = this URL |
| `POST /tasks/tick` | Cloud Tasks (ladder steps) | Google OIDC (`TASKS_SA_EMAIL`, audience = this URL) and `X-CloudTasks-QueueName` = `TASKS_QUEUE` |
| `POST /webhooks/twilio/gather` | Twilio `<Gather>` action (call menu) | `X-Twilio-Signature` |
| `POST /webhooks/twilio/sms` | Twilio inbound SMS | `X-Twilio-Signature` |
| `POST /webhooks/twilio/status` | Twilio call/SMS status callbacks | `X-Twilio-Signature` |
| `GET/POST /webhooks/whatsapp` | Meta verification and webhook | `hub.verify_token`; `X-Hub-Signature-256` |
| `POST /webhooks/openai` | OpenAI project webhook (`realtime.call.incoming`) | Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`, 5 min tolerance) |

**Why the webhooks live here and not in `api`:** the notifier holds the provider secrets and owns the call flow. ADR 0011 puts the inbound webhook (acks and opt-outs) with the notifier. Phone verification (Twilio Verify OTP, Geo Permissions, the charges acknowledgement) is user-facing, so it lives in `apps/api/src/phone` under `/v1/phone`.

### Messages

`notifications` carries one of these:

```json
{ "v": 1, "type": "notify", "uid": "…", "item": { "nid", "source", "urgency", "level", "counts", "coalesceKey", "deepLink", "createdAt", "approvalExpiresAt?", "mesaStartsAt?" } }
{ "v": 1, "type": "ack", "uid": "…", "via": "app|push|whatsapp|call|sms|desktop", "nid?": "…", "coalesceKey?": "…", "all?": true }
{ "v": 1, "type": "approval_expired", "uid": "…", "nid": "…" }
```

- **Unknown fields are dropped.** Producers can't smuggle content into a ladder.
- **`level` is the most the item may escalate to.** The producer maps risk and source to it:
  - `approval`: LOW/MED → L2, HIGH → L3, CRITICAL → L4;
  - `session_question`: L3;
  - `mesa_starting`: L4;
  - `security`: L4 (allowlist it in `l4_quiet_override` to break quiet hours);
  - `unanswered_messages`: L2;
  - `budget`/`trial`/`reminder`/`devmode`: L1.
- **`room-events`** carries `{ "v": 1, "uid", "roomId", "eid", "createdAt" }`. It becomes an L1 nudge.

### Call menu (D-014)

The call uses `<Gather input="dtmf speech" language="es-MX|en-US" numDigits="1" speechTimeout="auto" actionOnEmptyResult="true">`, with no `speechModel`. Voices come from `escalation.yaml` (`Polly.Mia-Neural`, `Polly.Joanna-Neural`).

| Input | What happens |
|---|---|
| **1** | Ack, then `<Dial timeLimit="…"><Sip>REALTIME_SIP_URI</Sip>`, bounded by this month's voice minutes (at most 20 min). The signed `X-Chalito-Ref` freezes the waiting items the call is for: only those can be answered on it (R-H3). Without voice, "open your app". |
| **2** | Snooze: re-call 1 min before a Mesa, else +10 min. |
| **3** | Dismiss (ack). |

The voice agent gets the items, labels and lines as JSON inside a `<data>` block, under a rule that data is never instructions (R-H3). Call voice is admitted on the hub and metered on the server (`packages/billing` README, "Voice sessions").

Spoken digits and words work too.

### Voice on the call (ADR 0005/0011)

1. **1** dials `<REALTIME_SIP_URI>?X-Chalito-Ref=<ref>`. The ref is HMAC-signed `{uid, nid, callSid, locale}`, expires in 2 minutes, and is single-use per instance. Twilio passes `X-` headers through, and OpenAI lists them in `sip_headers`.
2. `realtime.call.incoming` with a valid ref is accepted. Any other call is rejected (603). The accept carries:
   - the companion persona (the user's companion name);
   - the waiting items as references `i1…`, with call lines only when call briefing is on;
   - the pending approvals as `a1…`;
   - exactly two tools:
     - `answer_item(session_ref, text)` sends a sealed `call:<CallSid>` **RelayedCommand** to that session;
     - `push_approval(aid)` re-sends the approval to the app.

   **No tool decides anything.** Unknown tools and references do nothing. A test asserts that no notifier source can sign or write a decision.
3. The notifier follows the call on its server WebSocket (`wss://api.openai.com/v1/realtime?call_id=…`) and answers tool calls there. The call outlives the webhook request, so **the Cloud Run service needs CPU always allocated** (and a timeout covering a call).

## Data

The notifier runs as `chalito_server` (set `DATABASE_ROLE` when the login holds it with SET). It uses:

- `chalito.users`: escalation columns from migration `20261004001100`;
- `chalito_private.notification_ladders` and `notification_sends`, plus `chalito.push_subscriptions` (migration `20261004001200`);
- `chalito.notifications`, `call_lines`, `devices`, `sessions` and `commands`.

Decisions run under a per-user advisory lock. State and the sends that count toward the caps commit **before** anything is sent, so a crash can under-deliver but never double-send. `schema-request.sql` documents the shapes as agreed with the migration owner.

Presence contract with the agent and desktop app: `chalito.devices.presence = {"desktopActive": true|false}`. It counts only while `last_seen_at` is under 2 minutes old.

## Environment

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | This service's public URL. Twilio signatures and OIDC audiences are built from it. |
| `APP_URL` | Web app base, for SMS links (`<APP_URL>/n/<nid>`). |
| `DATABASE_URL`, `DATABASE_ROLE` | Supabase Postgres; role `chalito_server`. |
| `PUBSUB_SA_EMAIL` | Service account Pub/Sub push signs as. |
| `GOOGLE_CLOUD_PROJECT`, `TASKS_LOCATION`, `TASKS_QUEUE`, `TASKS_SA_EMAIL` | Cloud Tasks queue for ladder ticks, and the service account tasks sign as. |
| `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push. Generate with `npx web-push generate-vapid-keys`. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API: system-user token and sender number id. |
| `META_APP_SECRET`, `META_VERIFY_TOKEN` | Webhook signature and verification. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Calls and SMS (US local number by default, decision #17). |
| `REALTIME_SIP_URI` | Optional: `sip:<proj>@sip.api.openai.com;transport=tls;secure=true`. Setting it turns voice on and requires the next four. |
| `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` | Realtime SIP call control and the project webhook secret (`whsec_…`). |
| `VOICE_REF_SECRET` | Signs the `X-Chalito-Ref` SIP header that ties an OpenAI call to its Twilio call. |
| `REALTIME_VOICE` | OpenAI voice name (default `marin`). The model comes from `models.yaml` `voice.call`. |

All secrets come from Secret Manager. None are committed.

## Tests

- `pnpm --filter @chalito/notifier test`: every provider is mocked at the HTTP layer with msw (Graph, Twilio, Cloud Tasks, Web Push endpoints, Google's JWKS). Nothing real is sent. The tests cover:
  - OIDC forgeries;
  - a full ladder through every provider;
  - payloads free of content (secret-text fixture);
  - caps and quiet hours end to end;
  - Twilio and Meta signature forgery;
  - acks, opt-outs, 410 cleanup;
  - speech producing only a RelayedCommand.
- `pnpm --filter @chalito/notifier test:pg`: the Postgres store against a database with the migrations (CI: the `supabase` job).

## Runbook: the one real call and the one real template

This needs the owner's go. It sends one real call and one real WhatsApp template, so don't run it unattended.

1. **Prerequisites (OPS):**
   - the `chalito_pendientes_v1` template is approved in WhatsApp Manager, ES and EN (JSON in `templates/`);
   - the Twilio number is bought;
   - Geo Permissions include Mexico;
   - the owner's number is verified through `/v1/phone` (OTP), with calls and WhatsApp enabled. It comes from `OWNER_DEFAULT_PHONE_E164` via `scripts/seed-owner`; never commit it.
2. Deploy to the dev project with the variables above. Set the Pub/Sub push subscription and the Cloud Tasks queue to the service's URLs with OIDC.
3. **Template:** publish one message to `notifications`:

   ```sh
   gcloud pubsub topics publish notifications --message '{"v":1,"type":"notify","uid":"<owner uid>","item":{"nid":"runbook1","source":"approval","urgency":"high","level":"L3","counts":{"approvals":1,"questions":0,"messages":0,"mesas":0},"coalesceKey":"runbook:1","deepLink":"/","createdAt":<now ms>}}'
   ```

   - Push arrives at once.
   - The template arrives about 10 minutes later, or 3 minutes later for an approval with `approvalExpiresAt`.
   - Check that the template shows only the count, type and urgency, and that "Abrir" opens the app.
   - Tap "Dejar de recibir" and confirm `whatsapp_opt_in` turns false.
4. **Call:** publish the same message with `"level":"L4"`, `"nid":"runbook2"` and `"coalesceKey":"runbook:2"`, and wait for the call rung (about 15 minutes).
   - Confirm the Spanish briefing (Polly.Mia-Neural).
   - Press **2** and expect a re-call about 10 minutes later.
   - On the re-call press **3** and confirm the ladder stops (no SMS).
5. **Clean up:** ack anything pending:

   ```sh
   gcloud pubsub topics publish notifications --message '{"v":1,"type":"ack","uid":"<owner uid>","via":"app","all":true}'
   ```

   Then check that `chalito_private.notification_sends` shows exactly one call and one template.
