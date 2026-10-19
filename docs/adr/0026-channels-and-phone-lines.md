# ADR 0026: Channels and phone lines (shared number, bring your own line, free channels)

- Status: Proposed (M17 docs, 2026-10-16). Nothing is built until the owner's "go". Buying a number, registering a bundle or creating a bot is externally visible and needs the owner's go.
- Builds on: the escalation engine (`packages/escalation`), the notifier (`apps/notifier`), ADR 0005 (voice), ADR 0011 (call briefing vs WhatsApp content), owner decision #17 (Twilio number, pending).
- Protocol: `v` stays 1. `Channel` gains `telegram` (and later `slack`, `discord`); new schema `ChannelLine` (who owns the sending line).

## Context
Owner decision (2026-10-16): the phone line should work for the owner now **and** scale to users, including "connect your own line".

What exists (M6):
- Channels: `push`, `whatsapp`, `call`, `sms`. Ladders in `packages/escalation/src/ladder.ts` (push L1/L2, WhatsApp L3, call L4, SMS last).
- One sending identity: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` and `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`, all Chalito's.
- Monthly per-user caps per paid channel (`apps/notifier/src/caps.ts`, from `plans.yaml`), checked before the hub admit.
- Opt-out: STOP-style SMS replies (`stop|baja|alto|cancelar|unsubscribe`) opt out of SMS; WhatsApp needs opt-in; calls need `calls.enabled`; SMS off by default for MX numbers.
- Phone verification via Twilio Verify and a "pueden aplicar cargos" acknowledgement.

## Layer (a): a shared Chalito number on Twilio

### MX number vs US number (checked 2026-10-16)
| | **MX local** (+52, e.g. CDMX) | **MX mobile** | **US local** |
|---|---|---|---|
| Monthly | USD 6.25 | USD 15.00 | USD 1.15 |
| Outbound call to MX mobile | USD 0.0473/min | same | USD 0.0473/min (priced by destination) |
| Inbound | USD 0.0100/min | USD 0.0100/min | USD 0.0085/min |
| Regulatory bundle | **Yes.** Individual: government ID or passport + address **in the number's locality**. Business: Constancia de Situación Fiscal + local address. Proof within 12 months. No PO boxes. | **Yes, stricter.** Individual: ID with CURP (or residency card) + MX address proof within 3 months; max 10 numbers. Business: Constancia/registration, RFC, a public website, a representative's ID. | No bundle for voice in beta use (US A2P SMS needs 10DLC registration, which we don't need for calls) |
| SMS | Not our channel (see below) | **P2P only**: carriers block A2P/automated traffic on MX mobile numbers | Reaches MX, but **sender ID not preserved** (shows a short code or random local number) |
| Caller ID shown in MX | A familiar +52 number: higher answer rate | same | A +1 number: lower answer rate, and caller ID into MX isn't guaranteed (M6 risk) |

SMS to Mexico costs USD 0.1819 per segment on a long code, and MX A2P on long codes is "OTP only, best effort"; alphanumeric sender IDs need ~3 weeks of pre-registration. That matches the M6 choice: **SMS is the last rung, off by default for MX**, and WhatsApp is the text channel.

**Recommendation:** for the owner now, an **MX local number** (CDMX), with a bundle in the owner's (or the business's) name. It's USD 6.25/month and the calls Chalito makes are outbound to MX mobiles, where a +52 caller ID matters. A US local number stays the fallback if the bundle stalls. Decision #38: **still pending** (owner, 2026-10-16). M17 phase C ships Telegram first; the shared number waits for that decision.

Sources (checked 2026-10-16):
- Twilio MX voice pricing: https://www.twilio.com/en-us/voice/pricing/mx
- Twilio US voice pricing: https://www.twilio.com/en-us/voice/pricing/us
- Twilio MX regulatory requirements: https://www.twilio.com/en-us/guidelines/mx/regulatory
- Twilio MX SMS guidelines: https://www.twilio.com/en-us/guidelines/mx/sms
- Twilio MX SMS pricing: https://www.twilio.com/en-us/sms/pricing/mx

### Scaling the shared number
- One number serves many users for **outbound** calls (the call says who it's for and what it's about, never content: ADR 0011).
- Inbound SMS and WhatsApp replies are matched by the sender's verified phone (`findUserByPhone`, `waToE164`), so one number works for many users.
- Per-number limits: Twilio's default outbound call rate is per account (CPS); a pool of numbers can be added later behind the same `ChannelLine` abstraction.

## Layer (b): bring your own line
A user who wants calls and messages to come from **their own** number connects their own account. Chalito never buys numbers for users.

| | **BYO Twilio** | **BYO WhatsApp Business number (Meta Cloud API)** |
|---|---|---|
| What the user connects | Their Twilio Account SID plus a **restricted API key** (key SID + secret) limited to Calls, Messages and the one number, and which number to use | Their WhatsApp Business Account (WABA) and business phone number, through Meta **Embedded Signup** with Chalito registered as a **Tech Provider** |
| Where the secret lives | Sealed to the notifier's KMS key, stored per user (`chalito.channel_lines`); never shown again; rotate or remove any time | A business token from the Embedded Signup code exchange, stored the same way |
| Who pays | The user's own Twilio bill. Chalito admits no `call.seconds`/`sms` meter for BYO lines (like BYO models) | The user's WABA (Meta requires onboarded businesses to add their own payment method) |
| Templates | n/a | The user's WABA needs our template approved under their account (we submit it through the API after signup) |
| Limits | Their account's | Tech Providers can onboard 10 businesses per rolling 7 days by default, 200 after Business Verification, App Review and Access Verification. Embedded Signup v2 is deprecated as of 2026-10-15, so we build on **v4** |
| Webhooks | We set the number's voice/SMS URLs to our notifier (with the user's consent) and validate signatures with **their** auth token | Meta sends to our app's webhook; we map by phone number ID |

Notes:
- BYO lines change who sends, not what is sent: the same ladder, the same content rules, the same caps and quiet hours.
- A user's existing WhatsApp Business **app** number can join through Meta's "coexistence" onboarding (app 2.24.17+). A personal WhatsApp number can't.
- Becoming a Tech Provider needs Meta Business Verification and App Review, which is an owner task (decision #40).

Sources (checked 2026-10-16):
- Meta, onboarding customers as a Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
- Meta, Embedded Signup overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
- Meta, onboarding WhatsApp Business app users (coexistence): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users

## Layer (c): free channels
| Channel | Use | Notes |
|---|---|---|
| **Web push** (exists) | L1/L2, approvals deep link | Free. iOS needs the Home Screen install. |
| **Telegram bot** (new, proposed default free text channel) | Notifications **and approvals** | Free. Inline keyboard buttons send a `callback_query` without posting a message; we answer with `answerCallbackQuery`. Webhook with `secret_token` (header `X-Telegram-Bot-Api-Secret-Token`). Linking by deep link `t.me/<bot>?start=<code>` (≤64 chars, `A-Z a-z 0-9 _ -`): the user taps it, the bot gets `/start <code>`, we bind the chat to the user. A bot can't write to a user who never started it (it gets `403 Forbidden: bot can't initiate conversation`), which is exactly the consent we want. Limits: about 1 message/s per chat and about 30/s overall free, beyond that paid broadcasts. Bot API 10.3 (2026-08-24). |
| Slack DM | Notifications, approvals for people who live in Slack | A Slack app with a bot token per workspace, interactive buttons. Free on Slack's side. Later phase. |
| Discord DM | Same | A bot with DMs only to users who share a server or have authorised the app. Later phase. |

**Approvals over Telegram/Slack/Discord are not signed by a trusted client.** These channels can:
- notify and **acknowledge** (stop the ladder), and
- approve **LOW/MED** items only when the user chooses so (a button press is a `RelayedCommand` with origin `chat:<channel>`, treated like `call:`: it can answer, never decide HIGH/CRITICAL).
- HIGH and CRITICAL always open the app for a signed, passkey decision (a button deep-links there). This invariant doesn't change.

**Owner, 2026-10-16 (decision #41): both, the user toggles it.** A per-user setting `chatApprovals`: **"notify only" (default)** or **"approve LOW/MED from chat"**. Turning it on needs passkey step-up in the app; turning it off works from anywhere. The setting is part of local policy's ceiling, so a device can forbid it.

Sources (checked 2026-10-16):
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram bot features (deep linking, inline keyboards): https://core.telegram.org/bots/features
- Telegram bot FAQ (free, rate limits): https://core.telegram.org/bots/faq
- The "can't initiate conversation" 403 is seen in community reports, not the official page (e.g. https://qna.habr.com/q/1106310); treat as observed behaviour and re-check when building.

## Why not a physical Mexican SIM in a phone
A real Telcel or AT&T SIM in a spare phone looks like the cheapest "line". It is not a reliable or allowed API:
- **No official API.** Driving a phone's dialer or WhatsApp app with automation (Android intents, ADB, accessibility services, a "SIM bank") is driving a consumer UI, which our ground rules forbid.
- **Carrier rules.** Twilio's MX guidelines say local carriers "do not permit A2P or automated messaging" on MX mobile numbers and block it. Consumer SIM plans are for personal use; automated calling from them risks the line being cut. (We haven't read each carrier's consumer terms; treat the details as unverified, the direction as clear.)
- **WhatsApp needs a Business number on the Cloud API** for automated messages. Automating the consumer or Business app breaks WhatsApp's terms and gets the number banned.
- **Reliability.** One phone is one point of failure: battery, signal, OS updates killing background apps, no delivery receipts, no webhooks, no scale beyond one user.
- What works instead: the shared Twilio number (a), the user's own Twilio or WhatsApp Business line (b), or Telegram (c).

## Caps, consent and opt-out (all layers)
- **Consent per channel**, recorded with a timestamp: phone verified (Twilio Verify) + "pueden aplicar cargos" for calls/SMS; WhatsApp opt-in; Telegram `/start`; Slack/Discord app install. Nothing is sent before consent.
- **Caps per user**: the existing monthly caps per paid channel stay (`plans.yaml`), plus a daily ceiling per channel (default: 10 calls, 20 WhatsApp, 5 SMS, 100 Telegram) and per-line caps for shared numbers. BYO lines use the user's caps, with the same daily ceiling unless they raise it.
- **Opt-out everywhere**: SMS `STOP|BAJA|ALTO|CANCELAR` (exists); WhatsApp "BAJA" quick reply and the Meta opt-out; Telegram `/stop` or blocking the bot; a DTMF "9" on calls to stop calls for 30 days; one "Stop all" in settings. Opt-outs are honoured within one ladder step and logged.
- Quiet hours apply to every channel (Twilio also advises no MX SMS between 21:00 and 09:00).

## Consequences
- `packages/escalation` gets `telegram` in `Channel` and a ladder slot (proposed: Telegram replaces WhatsApp at L3 when the user has no WhatsApp opt-in, and joins L2 as a free rung).
- `apps/notifier` gets a `ChannelLine` resolver: per user, which line (shared or BYO) sends each channel, with that line's credentials.
- `docs/THREAT_MODEL.md` gains §4.10a: BYO credentials at rest (KMS-sealed, restricted keys), webhook spoofing per line (per-line signature secrets, Telegram `secret_token`), and chat-channel approvals (never HIGH).
- `docs/LEGAL_CHECKLIST.md` gains: MX bundle data handling, Tech Provider terms, Telegram bot privacy notice.
