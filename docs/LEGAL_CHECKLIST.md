# Legal checklist

A checklist **for counsel**: what Chalito says, collects and promises, and where each item lives in the repo. **This is not legal advice.** Every item marked "needs lawyer" waits for counsel's review before public launch.

**Status values:**
- **done:** text exists and is wired, but is still subject to counsel's review.
- **draft:** text exists but isn't final or isn't wired.
- **needs lawyer:** there's nothing yet, or it's a legal judgment.
- **hub:** owned by the Chalyb hub, not Chalito.

**Context:**
- Chalito is a Chalyb engine (ADR 0016). Sign-in, payments (Mercado Pago), the trial, refunds and invoicing are the hub's.
- Data lives in the hub's Supabase and Chalyb's GCP project (us-central1).
- The default market is Mexico (es-MX). English is offered.

## 1. Privacy

| # | Item | Status | Where / notes |
|---|---|---|---|
| 1.1 | Privacy notice, ES and EN, shown in the app and linked from sign-in | needs lawyer | No page exists in `apps/web/src/app/[locale]/`. Decide whether it's Chalito's own notice or a section of Chalyb's. |
| 1.2 | **LFPDPPP: aviso de privacidad** (integral and simplified): identity of the controller, purposes (primary and secondary), data categories, transfers, ARCO channel, changes | needs lawyer | Controller is Chalyb or the owner's entity: confirm. Name the data categories: device keys and fingerprints, phone number (`chalito.users.phone_e164`), session metadata, approvals metadata, audit log, voice (OpenAI Realtime, audio never transits Chalito), call briefing lines. |
| 1.3 | **ARCO rights** (access, rectification, cancellation, opposition): a request channel, a 20-business-day answer, identity check | needs lawyer | Access can lean on the owner-readable audit views (`docs/SECURITY_EVENTS.md`). Deletion with an export first, a 7-day cancellable grace and a passkey step-up is built (`/v1/account`, `docs/RUNBOOK.md` 6.6); the hub account is the hub's. Counsel: confirm the grace and what billing data must be kept. |
| 1.4 | **Transfers to US processors**, with consent where LFPDPPP requires it | needs lawyer | Processors: Google Cloud (Cloud Run, Pub/Sub, BigQuery, Secret Manager, Vertex/Gemini), Supabase, Vercel, OpenAI (voice, managed brains), Anthropic, xAI, Twilio (calls, SMS, Verify), Meta (WhatsApp). Model calls carry only what the person sends (BYO keys stay on the device: ADR 0004/0005). |
| 1.5 | **GDPR** for EU users: lawful basis per purpose, Art. 13 notice, DPA with each processor, SCCs for US transfers, data subject rights, a RoPA | needs lawyer | Or decide to block the EU at launch. |
| 1.6 | Retention schedule | draft | Room events 24 h by default (decision #12, `packages/config/rooms.yaml`); sent usage-outbox rows 30 days (`packages/billing/README.md`); voice call refs 1 h (migration 001600); session events via TTL (migration 000500). The audit log has no retention limit set: decide. |
| 1.7 | Privacy mode (`private` vs `cloud_assist`) explained to users | draft | `packages/ui/messages/{es,en}.json` → `privacyMode`; `apps/web/src/lib/settings-store.ts`. |

## 2. Terms

| # | Item | Status | Where / notes |
|---|---|---|---|
| 2.1 | Terms of service, ES and EN | needs lawyer | No page exists. They must contain the Developer-mode clause (2.2), the AI-output disclaimers, and the acceptable use for rooms and uploads. |
| 2.2 | **Developer-mode liability clause**, versioned, and identical to the in-product text | draft | `packages/config/legal/devmode-liability.{es,en}.md`: version 1, toggle phrases `ACEPTO` / `I ACCEPT`. Loaded by `loadLiabilityText` (`packages/config/src/load.ts`) and shown by the agent CLI (`apps/agent/src/cli.ts`). Acceptance is signed and hash-chained on the device (`apps/agent/src/devmode.ts`, ADR 0008). **Counsel:** review the wording, and confirm the ToS clause carries the same version number. A text change must bump `version`. |
| 2.3 | AI output disclaimer: companions and Mesa participants can be wrong, and decisions stay with the person | needs lawyer | Every approval is signed by the person (ADR 0006/0007). |
| 2.4 | Acceptable use: rooms, uploads, harassment | needs lawyer | See section 5. |

## 3. Disclosures in the product

| # | Item | Status | Where / notes |
|---|---|---|---|
| 3.1 | **MCP card sharing**: the card is stored unencrypted so connected apps can read it | done (text) | `packages/ui/messages/es.json` → `sharing.warning` / `sharing.ack`, plus the EN equivalent. Off by default, with an explicit acknowledgement. Audited as `mcp.sharing_on` / `mcp.sharing_off`. |
| 3.2 | **Call briefing**: lines leave the computer unencrypted to be read aloud | done (text) | `packages/ui/messages/es.json` → `callBriefing.plaintext`. Opt-in (decision #10). |
| 3.3 | **"Charges may apply"** ("Pueden aplicar cargos") before any paid channel | done | Acknowledgement stored in `chalito.users.charges_notice_ack_at`, enforced in `apps/api/src/phone/routes.ts`, copy `charges`/`chargesAck` in `packages/ui/messages/*.json`. |
| 3.4 | AI voice disclosure on calls: the caller is an automated assistant | needs lawyer | Call scripts are in `apps/notifier` (Polly voices, `escalation.yaml`). Check the MX and US rules for automated calls. |
| 3.5 | Credit line in the user's language (decision #11) | done | Owner decision D-028. |

## 4. Providers' terms

| # | Item | Status | Where / notes |
|---|---|---|---|
| 4.1 | **WhatsApp Business / Meta**: Business Messaging Policy, opt-in before utility templates, opt-out honoured, template approval | draft | Opt-in in `apps/api/src/phone/routes.ts`; "Dejar de recibir" opt-out handled by the notifier (`apps/notifier/README.md` runbook step 3); template `chalito_pendientes_v1` (approval is an OPS item). |
| 4.2 | **Twilio**: AUP, Verify, calls and SMS to MX; **10DLC** registration if a US number sends SMS to US users | needs lawyer | Number choice is decision #17 (US local number by default). 10DLC brand and campaign registration is an OPS item. Geo Permissions limited to the markets offered. |
| 4.3 | **Codex "Sign in with ChatGPT"**: OpenAI's confirmation before opening it beyond the owner | needs lawyer | `packages/config/providers.yaml` → `subscriptionLocal: owner_only` until OpenAI approves (D-003). |
| 4.4 | Claude Code / Anthropic consumer terms for subscription use on the person's machine | needs lawyer | The agent drives the person's own install (ADR 0004). Confirm nothing resells access. |
| 4.5 | MCP connectors (ChatGPT, Claude) directory terms | needs lawyer | `apps/mcp-gateway/README.md`. |

## 5. User content and avatars

| # | Item | Status | Where / notes |
|---|---|---|---|
| 5.1 | **Avatar upload terms**: the uploader owns the rights or has a licence; no third-party characters, trademarks or NSFW | needs lawyer | Uploads are validated and re-encoded by `apps/avatar-jobs` (no metadata kept), stored privately under the owner's prefix, and visible only to room co-members (THREAT_MODEL "IP infringement"). The upload UI is **not yet built**. |
| 5.2 | **Takedown** (DMCA-style notice and counter-notice; MX equivalents) | needs lawyer | A report button is **not yet built** (`docs/RUNBOOK.md` 6.5). Operator removal: delete `avatars/<owner>/<asset>/` in the bucket. |
| 5.3 | Room content: end-to-end encrypted, so Chalito can't moderate content, only metadata | needs lawyer | Say so in the ToS and privacy notice. |

## 6. Money (hub)

| # | Item | Status | Where / notes |
|---|---|---|---|
| 6.1 | Digital goods and credits: refund terms, no cash value, no expiry (decision #8) | hub | Chalito sells cosmetics for hub tokens (`packages/config/catalog.yaml`, `/v1/store`). Refunds and chargebacks are the hub's (THREAT_MODEL "Refund abuse"). The terms must say cosmetics are cosmetic only (pay-to-dress, `apps/api/test/pay-to-win.test.ts`). |
| 6.2 | Trial terms | hub | The hub's rules (decision #7, D-026). |
| 6.3 | **MX invoicing (CFDI)** | hub | The hub invoices: Mercado Pago, ADR 0012. |
| 6.4 | Prices shown match the config, with no hidden currency | done | The currency lint (`pnpm lint:currency`). Prices are in tokens. |
| 6.5 | Consumer protection (PROFECO): clear price display and cancellation | hub | |

## 7. AI-generated assets

| # | Item | Status | Where / notes |
|---|---|---|---|
| 7.1 | Provenance log of every shipped image | done | `docs/ASSET_PROVENANCE.md`: model, prompt, seed, date for the roster, icons and cosmetics. |
| 7.2 | Google Gemini API / AI Studio terms: commercial use of outputs, the prohibited-use policy | needs lawyer | Generated with `gemini-3.1-flash-image` via the Gemini API. Confirm the output rights under the terms in force on the generation date. |
| 7.3 | `proprietary-generated` licence label: ownership claim and copyrightability of AI outputs (MX and US) | needs lawyer | `packages/roster/src/index.ts` (`license`). Outputs may not be copyrightable. Decide what the label promises. |
| 7.4 | No third-party characters in prompts or likeness | done | Prompts in `apps/avatar-jobs/scripts/generate-roster.ts` describe original characters only. |
| 7.5 | Marketing renders (M13): real renders, not AI-generated stand-ins | draft | `docs/PLAN.md` M13. |

## Before public launch

- [ ] 1.1–1.5 privacy notice and processor DPAs signed off
- [ ] 2.1–2.2 ToS published, with the Developer-mode clause version matching `packages/config/legal/devmode-liability.*.md`
- [ ] 3.4 automated-call disclosure confirmed
- [ ] 4.1–4.3 provider approvals (WhatsApp template, Twilio/10DLC, OpenAI SIWC)
- [ ] 5.1–5.2 upload terms and a takedown channel
- [ ] 7.2–7.3 AI asset rights confirmed
