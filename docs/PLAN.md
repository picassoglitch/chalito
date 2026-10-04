# Chalito beta: plan

- Owner: Aldo (picassoglitch)
- Written: M0, 2026-10-03
- Status: **awaiting owner "go"** (revised 2026-10-03 after the owner's answers: Chalito is a Chalyb engine)

This is the build plan for the Chalito beta. It is the milestone list from the brief, adjusted to the APIs verified on 2026-10-03 (`docs/VERIFIED_APIS.md`), with risks per milestone. Where the plan differs from the brief, the reason is in `/DEVIATIONS.md`. Design decisions are in `docs/adr/`. Security invariants are in `docs/THREAT_MODEL.md`.

## Ground rules carried into every milestone
- **Chalito is a Chalyb engine** (ADR 0016).
  - Accounts come through hub SSO. Payments (Mercado Pago), the trial, packs and the billable-token balance are the hub's.
  - Chalito admits work before spending, reports every cost, and settles.
  - It's still its own repo. Chalyb-side changes go in Chalyb's own PRs, with the owner's go.
- **Official interfaces only.**
  - Claude Code via the Agent SDK, unmodified, under the user's own **API key** (D-002).
  - Codex via `codex app-server`, under the user's own API key **or ChatGPT plan through official Sign in with ChatGPT** (D-003).
  - Brains via provider APIs. MCP connectors via their official features.
  - We never scrape or drive consumer UIs. We never touch claude.ai or ChatGPT credentials.
- **The device is the root of trust.** Local policy is the ceiling. The local trusted-client list decides who can approve. Developer mode turns on only locally.
- **Firestore is the only database.** No polling, and no repo used as a brain.
- **Prices only in `packages/config`.** `plans.yaml` holds exactly the owner's ladder.
- **Nothing that costs money or is externally visible without the owner's go.** That covers cloud resources, numbers, messages and calls, live payment products, and published builds.
- **Repo flow.**
  - `main` starts with this M0 commit.
  - Each milestone gets a branch `m<N>-<slug>` and a PR into `main`.
  - Commits are authored as picassoglitch.
  - After each milestone: a summary, test results, deviations, then the next plan, and we **stop for "go"**.
- **Art.** Any images or art (free roster textures, cosmetics, store art, icons) are generated with **Google AI Studio (Gemini image models)** for quality, and each asset's prompt, model and date is recorded in `docs/ASSET_PROVENANCE.md`. The Solo landing still uses **real renders** of the runtime (M13). AI art is only source material fed into that runtime.

## Milestones

### M0: Planning (this commit)
- **Delivered:**
  - `docs/VERIFIED_APIS.md`, this plan, 16 ADRs, `docs/THREAT_MODEL.md`, `DEVIATIONS.md`.
  - `packages/protocol` zod schemas plus 18 schema tests: typecheck clean, tests green in an isolated scratch install.
  - `packages/config/plans.yaml`, validated by `PlansConfig`.
- **Review asks:** the protocol shapes below, `plans.yaml`, and the owner decisions at the end.

### M1: Foundations + brand
- **Scope:**
  - Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, TS strict presets, ESLint + Prettier, Vitest.
  - CI (GitHub Actions): lint, typecheck, test, gitleaks, `lint:brand`, currency-literal lint.
  - `packages/crypto`: libsodium-wrappers — Ed25519, X25519 sealed boxes, `SealedEnvelope`, room keys with epochs, JCS canonicalization, nonce store interface.
  - `packages/brand`.
  - `packages/config` loaders (`plans.yaml` + stubs for `models.yaml`, `prices.yaml`, `catalog.yaml`, `rooms.yaml`, `render.yaml`, `providers.yaml`).
  - `infra/terraform` for **Chalito-only resources in Chalyb's GCP project**: named Firestore database `chalito`, Pub/Sub, Cloud Tasks, KMS, buckets, BigQuery `chalito`, extra Cloud Run services and service accounts, with its own state. CI runs `fmt`/`validate`/`tflint`/`checkov`. No apply without the owner's go.
  - The engine entry itself (SA, secrets, `api` service, domain mapping) goes in Chalyb's tfvars at M2.
- **Done when:** CI green, `plans.yaml` validates, crypto and brand tests pass.
- **Risks:**
  - The JCS implementation must match across runtimes (Node, bun, browser). Mitigation: shared test vectors.
  - Chalyb's Terraform state is local on the owner's machine. Chalito keeps separate state so the two never collide.

### M2: Control plane + pairing (Chalito Glyph)
- **Scope:**
  - Terraform modules: named Firestore database `chalito` in `us-central1` plus TTL fields, Pub/Sub plus DLQs, Cloud Tasks, secret containers, KMS, Cloud Run services, BigQuery plus Pub/Sub→BQ subscriptions.
  - **Engine contract:** `/tenants` + `/tenants/{id}/status` on `api`, and `/auth/sso` on `web` (HMAC verify, relative `next`).
  - Chalyb-side PR: definitions entry + `register_chalito_engine` migration (`coming_soon`) + tfvars + Vercel env. **Needs the owner's go.**
  - `api` on Hono: Firebase custom tokens after SSO, passkey enrolment (second factor), phone-first pairing (ADR 0006), signed refresh challenge, endorsement, revocation, recovery with cool-down.
  - `packages/glyph`: ring encoder/decoder with RS + fountain coding and the short-code fallback.
  - `firestore.rules` + emulator tests.
  - WebAuthn credential registration bound to the reverse check (D-019).
- **AC (from the brief):**
  - The agent receives a command through a listener in under 2 s.
  - Revocation blocks the next read.
  - Glyph round-trip property test.
  - Expired or claimed codes rejected.
  - A revoked phone signature is rejected by the agent.
  - A new phone needs local confirmation.
  - Approver-injection test.
  - Post-revocation sealing excludes the revoked key.
- **Risks:**
  - The hub SSO secret becomes a high-value secret (THREAT_MODEL §4.14).
  - Firebase custom token TTL is fixed at 1 h, so the refresh loop must be robust offline.
  - Glyph camera decoding across phone cameras and screen refresh rates. Mitigation: tune symbol count and frame rate with real devices; the short code is always available.
  - Cloud Run domain mapping is Preview.

### M3: Device agent + Claude Code adapter + signed approvals
- **Scope:**
  - `chalito-agent`, built with bun `--compile` and checked by a smoke test that `@napi-rs/keyring` loads.
  - Keychain keys, signed trusted-client list, `policy.yaml` with tiers and `policyHash`, Developer mode (local OS auth + triple confirm + liability record), origins policy.
  - User services: LaunchAgent, systemd `--user`, Windows per-user Scheduled Task (D-005).
  - IPC socket/pipe.
  - Claude Code adapter:
    - streaming-input `query()` with `permissionMode:'default'` pinned (D-004);
    - **PreToolUse hook with no matcher** as the single policy gate (timeout 660 s, or `defer`);
    - `canUseTool` for AskUserQuestion;
    - `ANTHROPIC_API_KEY` from the keychain through `options.env`;
    - the user's `claude` binary via `pathToClaudeCodeExecutable` (D-008).
  - Deterministic Session Card. callLines publisher.
- **AC:** all brief M3 tests, plus:
  - A missing `claude` binary gives a clear onboarding error.
  - An omitted mode never yields `auto`.
- **Risks:**
  - SDK churn: 0.3.x is released almost daily. Pin it and run the fake-CLI conformance suite.
  - OS-auth prompts for Developer mode per OS (LocalAuthentication / Windows Hello / polkit).
  - The Linux Secret Service may be missing on headless setups (fallback: passphrase-encrypted file).
  - The hook-timeout behaviour on long phone waits needs a real-run check (`scripts/e2e-claude.md`).

### M4: Codex adapter (+ Grok Build ACP stretch)
- **Scope:**
  - `codex app-server` over stdio JSONL (D-021): `initialize`/`initialized`, `thread/start|resume`, `turn/start|interrupt`.
  - Approval requests → Approvals, answered with `accept|decline|cancel`.
  - Deltas coalesced into AgentEvents.
  - Auth: API key, or **Sign in with ChatGPT** (official SIWC flow: PKCE + loopback, token handed to app-server via the `openai_chatgpt_plan` provider, refresh + restart + `thread/resume`). Gated `owner_only` until OpenAI approves (D-003).
  - Stretch: generic ACP adapter tested with `grok agent stdio`, using the user's Grok Build login or `XAI_API_KEY` (D-022).
- **AC:** contract tests on a recorded transcript; both adapters pass the shared `SessionAdapter` conformance suite.
- **Risks:**
  - app-server is "experimental, not for production" and its protocol may change. Pin the Codex version range and generate types with `codex app-server generate-ts` into fixtures.
  - OpenAI may not approve SIWC for a paid app, in which case public users stay on API keys.
  - SIWC preview limits apply (`store:false`, no hosted tools).
  - xAI has published no terms for third-party embedding of Grok Build logins.

### M5: Web/PWA + onboarding + in-app config
- **Scope:**
  - Next.js 16 on **Vercel** at `chalito.chalyb.com` (App Router, `proxy.ts`), next-intl 4 (`as-needed`, `localeDetection:false`), Tailwind, Firebase JS SDK, libsodium.
  - WebAuthn step-up. FCM `register()` (D-015).
  - Inbox with countdown. Approve/deny with local signing.
  - Onboarding (7 steps, including the "Saltar" avatar step).
  - Connections (BYO per provider from `providers.yaml`, honest copy: Claude Code and Codex need an API key in beta).
  - MCP grants, card sharing, call-briefing opt-in, Developer-mode badge + off controls.
  - Shared `packages/ui/settings` registry plus the settings-parity test.
- **AC:** brief M5 (Playwright against emulators, Lighthouse PWA installable, ciphertext-only check, no route enables Developer mode).
- **Risks:**
  - iOS web push needs a Home Screen install (16.4+), so onboarding must guide it.
  - Non-extractable Ed25519 in WebCrypto varies by browser. The fallback is wrapped libsodium keys in IndexedDB.

### M6: Escalation engine + comms
- **Scope:**
  - Pure `packages/escalation`: levels, ladder, quiet hours, caps, coalescing, presence, briefing builder.
  - `notifier`:
    - FCM push.
    - WhatsApp Graph **v26.0** templates (D-013).
    - Twilio Voice: `<Say>` with Polly es-MX/en-US, `<Gather>` without `speechModel`, `<Dial><Sip>` TLS+SRTP to OpenAI Realtime (D-014), with a Media Streams fallback.
    - SMS last rung.
  - Phone verification via Twilio Verify. Geo-permission check. "Pueden aplicar cargos" acknowledgement. `seed-owner`.
- **AC:** brief M6 property and snapshot tests, plus a manual runbook for one real call and one real template. **That runbook needs the owner's go**, because it sends real messages.
- **Risks:**
  - Meta may classify the counts-only template as marketing. Mitigation: specific fixed text; appeal path.
  - Community reports of OpenAI SIP per-project gating and 408s. Mitigation: Media Streams fallback.
  - Unverified Meta business is capped at 250 recipients/day.
  - Caller ID into MX from a US number is non-guaranteed.

### M7: Desktop companion + lifelike animation
- **Scope:**
  - Tauri **2.12** pet/panel/room windows: transparent, `shadow:false`, always-on-top, skip-taskbar.
  - Click-through by Rust-side `cursorPosition()` polling against the alpha mask (D-006; XWayland on Linux).
  - three-vrm 3.5 runtime with emotions → expressions; the VRM0 `surprised` fallback maps to `happy` + brow morph or a gesture.
  - Visemes from output audio, idle/gaze/blink, gestures, the L0–L4 machine, and the tired animation.
  - Push-to-talk Realtime WebRTC (`gpt-realtime-2.1-mini`) with an ephemeral key from `api`.
  - Presence. Local-only security screens.
- **AC:** brief M7, including ≤5% CPU idle (documented method) and the manual OS matrix.
- **Risks:**
  - WebKitGTK transparency on some GPUs (`WEBKIT_DISABLE_DMABUF_RENDERER`).
  - Wayland.
  - macOS focus-stealing rules.

### M8: Avatars + pay-to-dress store
- **Scope:**
  - `avatar-jobs`: validation, re-encode, image → 2.5D card, thumbnails.
  - Free roster: bear, animals, a few characters. **Source art via AI Studio**, rigged and exported to VRM, with provenance in `ASSET_PROVENANCE.md`.
  - Cosmetics slots/anchors, `catalog.yaml` (seed items `free: true`), store UI.
  - Purchases paid from the hub balance (`store.purchase`; hub change D-030).
- **AC:** brief M8, including the pay-to-win property test.
- **Risks:**
  - Turning AI images into rigged VRMs takes manual or tooling effort. Budget time; the image-card avatar is the fallback.
  - IP and takedown process.

### M9: Mesa + token efficiency
- **Scope:**
  - Moderator: rules first, then a cheap model.
  - Router/summarizer on `gemini-3.1-flash-lite@global` (D-012); brains via provider APIs.
  - Addressed-only calls. Briefs = cached persona + goal + Mesa Card + last 3 turns.
  - Prompt caching:
    - Anthropic `cache_control`: mind the minimums (512–4,096 tokens per model) and Opus 5.5's 0.05× reads.
    - OpenAI: automatic, with a 1.25× write cost on GPT-5.6+.
    - xAI: cached input.
  - `usage_events` with purpose and billingMode. Comms-overhead page. Budgets.
- **AC:** brief M9.
- **Risks:**
  - Cache minimums mean short briefs don't cache. Measure; don't assume savings.
  - Model retirements (Haiku 4.5, Gemini 2.5) mean model ids must live only in `models.yaml`.

### M10: MCP gateway
- **Scope:**
  - Spec 2026-07-28 via TS SDK v2 + `@modelcontextprotocol/hono`.
  - OAuth AS on `api` with CIMD preferred and DCR compatible (D-017); 2FA sign-in.
  - Scopes `mcp:read`, `mesa:post`, `approval:recommend`, `session:prompt`. Five tools.
  - Card sharing opt-in.
- **AC:** brief M10. Connector setup documented for ChatGPT (Developer mode: Plus/Pro/Business/Enterprise/Edu; now called "Plugins") and Claude (custom connectors on all plans; one connector on Free).
- **Risks:**
  - Client compatibility across MCP revisions. Claude's docs still reference 2025-11-25, so support version negotiation for both.

### M11: Rooms + companion messaging + portal scene
- **Scope:** ADR 0010 — API, notifier fan-out, room keys and epochs, retention, promotion to records, `.ics` and reminders, dissolve, deterministic `packages/scene`, portal, quality slider.
- **AC:** brief M11, including the prompt-injection fixture, under-2 s delivery with no read loops, and determinism across two viewers.
- **Risks:**
  - Listener read cost in busy rooms. Mitigation: addressed fan-out, TTL, load test in M15.
  - Firestore TTL lag (≤24 h typical), so a client-side filter is mandatory.

### M12: Hub billing integration
- **Scope:**
  - `packages/billing`: hub client (admit / usage / settle / balance), Firestore usage outbox + drainer, entitlements (hub tier or Solo tier → access row; progressive limits; `maxProfile`).
  - Efficiency profiles. In-character out-of-energy flow. `/creditos` shows the hub balance and links to hub plans and packs.
  - Solo line through the hub checkout ("Disponible pronto" until MXN amounts exist, D-031).
  - OWNER_UIDS comped. Chalyb-side meter kinds (D-030).
- **AC:**
  - Every managed spend is admitted first; refused admits do no work.
  - Usage events are idempotent across restarts (outbox test).
  - BYO and Claude Code/Codex never produce billable events.
  - Pay-to-win property.
  - Out-of-energy e2e: no `role=dialog`, chip routes to `/creditos`.
  - Hub outage: managed fails closed, approvals still work.
  - Every price shown equals config.
- **Risks:**
  - Depends on hub uptime and contract stability.
  - Meter kinds must be accepted by the hub.

### M13: Solo landing (real renders)
- **Scope:** `scripts/render-showcase.ts` (Playwright + WebGL) exports real renders into `public/showcase/` with a manifest. Animated ES/EN landing. Plans section rendered from `plans.yaml`. Reduced-motion posters.
- **AC:** brief M13 (the build fails on assets missing from the manifest).
- **Risks:** headless WebGL determinism in CI (use the software renderer and pinned seeds).

### M14: Downloadable apps
- **Scope:**
  - Tauri bundles: AppImage/deb/rpm, NSIS, universal DMG.
  - Signing: Azure Artifact Signing, Developer ID + notarization with App Store Connect API keys (D-011).
  - Updater with signed `latest.json` behind signed URLs from a private bucket in Chalyb's project. CI matrix producing **draft** releases. `/descargar`.
- **AC:** brief M14. **Publishing requires the owner's go**, and needs the Apple Developer account, Azure Artifact Signing, and the updater key (OPS).
- **Risks:**
  - SmartScreen reputation ramp.
  - Universal sidecar lipo.
  - Notarizing bun-compiled binaries (JIT entitlements).

### M15: Hardening + docs
- **Scope:** rate limits, audit views, load test (1k devices + room fan-out), `RUNBOOK.md`, `LEGAL_CHECKLIST.md`, `OPS.md`, `CHALYB_HANDOFF.md` (flag off), README from zero (under 30 min, verified literally).
- **Risks:** the load test needs a real dev project, so it costs money (owner's go).

## Protocol review (for the owner)
Everything is in `packages/protocol/src`, and every wire object has `v: 1`:

| Schema | Notes |
|---|---|
| `common.ts` | ids; `CompanionId` = `chl_` + 26 base32; `Origin` (local / client / mcp / call — no room); `RemotePermissionMode` (no bypass/dontAsk/auto); `RemoteCodexSandbox` (no danger-full-access); emotions; counts; units |
| `crypto.ts` | `SealedEnvelope` (multi-recipient), `RoomSealed`, closed set of signing contexts, `signed()` wrapper, `Endorsement` |
| `approval.ts` | `ApprovalRequest` (TTL ≤10 min; HIGH/CRITICAL ⇒ step-up), `Decision` (signed; bound to aid + requestId + targetDeviceId + nonce; ≤10 min), WebAuthn assertion, `ResolutionReason` |
| `command.ts` | `CommandPayload`, which has **no enable/loosen/trust-add shapes**; `SignedCommand`; `RelayedCommand` (mcp/call may only prompt or answer) |
| `agentEvent.ts` | `AgentEvent` v1 (metadata plaintext, content sealed); `DeviceEvent` (policy, Developer mode, rejected remote-enable) |
| `sessionCard.ts` | ≤300-token card (estimator; tokenizer cross-check in M9) |
| `mesa.ts` | `ParticipantRef`, `ParticipantOutput` (emotion required), `MesaCard`, `MesaTurn` |
| `notification.ts` | `Notification`, `OutboundTemplateVars` (strict ints/enums), `CallLine` (one sentence; no paths, URLs or command syntax), `CallBriefing` |
| `room.ts` | `Room`, `RoomMember`, `RoomEvent`, `RoomEventBody` (data-only kinds), `RoomInvite` |
| `glyph.ts` | `GlyphPayload` (signed; pairing ≤5 min), `PairingCode`, `ShortCode` |
| `companion.ts` | `Companion`, `CompanionReply` (emotion mandatory; chips, never modals) |
| `plans.ts` | `PlansConfig` for `plans.yaml`: Solo ladder + hub-tier access map; enforces bucket = ladder price, the hub sizing rule (allowance never bills more than the price) and monotonic progressive access |
| `billing.ts` | Hub contract mirrors: `HubSsoPayload`, `HubTenantCreate`, `HubAdmitRequest/Response`, `HubUsageEvent` (token split must sum), `HubSettle`; `Entitlements` (`safetyFeatures: true`), `EntitlementInputs` (`.strict()`, no inventory) |

## Owner decisions
See the end of the M0 hand-off message. The same list is mirrored here for the record.

| # | Decision | Status (2026-10-03) |
|---|---|---|
| 1 | Inclusions per tier | **Owner: progressive, margin first.** Filled in `plans.yaml` (D-009); review the numbers. |
| 2 | Bundle → tier mirror | Default accepted: `bundle_8` → Lite, `bundle_40` → Standard |
| 3 | Efficiency ↔ tier | Accepted |
| 4 | Solo includes MCP gateway | Accepted: all tiers |
| 5 | Efficiency on Solo | Accepted |
| 6 | `free_min` behaviour | Accepted: deterministic-only |
| 7 | Trial | **Owner: align with the Chalyb standard.** The hub's trial rules (D-026). |
| 8 | Credit expiry | Accepted: never |
| 9 | Payments | **Owner: the Chalyb hub (Mercado Pago), as for ChalyClip.** No Stripe (ADR 0012/0016). |
| 10 | Call briefing lines | Accepted: on, with disclosure |
| 11 | Credit line language | **Owner: follow the user's language** (D-028) |
| 12 | Room retention | Accepted: 24 h, keep promoted |
| 13 | "¿Lo agendo?" target | Accepted: reminder + `.ics` |
| 14 | Native phone apps | **Pending** (PWA meanwhile) |
| 15 | Room urgency sharing | Accepted: off |
| 16 | Cosmetic prices | Accepted: seed items free |
| 17 | Twilio number | **Pending** (US local assumed in docs) |
| 18 | Chalyb integration live | **Owner: on.** Chalito is a Chalyb engine (D-025). |
| 19 | Claude Code via subscription login | API key only unless Anthropic approves; owner may ask Anthropic |
| 20 | Recovery cool-down | Accepted: 1 h |
| 21 | Bundle `claude` binary | Accepted: use the user's install |
| 22 | Domain | **Owner: `chalito.chalyb.com`**; owner is checking own Chalito domains |
| 23 | Stripe entity | **Owner: no Stripe** (moot) |
| 24 | Windows signing | **Pending** |
| 25 | Front door | **Owner: Vercel** (ADR 0015) |
| 26 | Codex ChatGPT plan | **Owner: make it work.** Official SIWC, `owner_only` until OpenAI approves (D-003) |
| 27 | Grok Build login | **Owner: on** (D-022) |
| 28 | Unsigned origins default | Accepted: on, tightenable |
| 29 | Spoken PIN on calls | **Owner: feature toggle, default off** |
| 30 | Firestore location | Accepted: `us-central1` (named database `chalito`) |
| 31 | **New:** MXN charge amounts for the Solo USD ladder on the hub | Unset; Solo checkout "Disponible pronto" until set |
| 32 | **New:** Hub changes for Chalito meter kinds + `store.purchase` | Proposed for the Chalyb PR at M2/M12 (D-030) |
| 33 | **New:** Add Firebase to Chalyb's GCP project (custom-token sign-in, rules deploy) | Off until the owner says so (`enable_firebase = false`) |
