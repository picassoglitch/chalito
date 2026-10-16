# Chalito beta: plan

- Owner: Aldo (picassoglitch)
- Written: M0, 2026-10-03
- Status: **M0–M15 code-complete; going live is owner-gated (`docs/GO_LIVE.md`, plain-language summary in `docs/OWNER_SUMMARY.md`)** (updated 2026-10-04). Revised 2026-10-03 after the owner's answers: Chalito is a Chalyb engine.

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

## Status by milestone (2026-10-04)

**Status values:**
- **Done:** merged to `main`.
- **Code-complete:** on the integration branch `all` ([#15](https://github.com/picassoglitch/chalito/pull/15), CI only), with its milestone PR open for the owner's go.
- **Owner-gated:** code-complete, but going live needs owner items (`docs/OPS.md`, `docs/GO_LIVE.md`).
- **Deferred:** not built for the beta.

| Milestone | Status | PR | Owner-gated on | Deviations |
|---|---|---|---|---|
| M0 Planning | Done | (first commit on `main`) | — | — |
| M1 Foundations + brand | Done | [#1](https://github.com/picassoglitch/chalito/pull/1) | — | D-001 |
| M2 Control plane + pairing | Done | [#2](https://github.com/picassoglitch/chalito/pull/2) | Chalyb engine PR (GO_LIVE Phase 1) | D-025, D-054 |
| M3 Agent + Claude Code + signed approvals | Done | [#4](https://github.com/picassoglitch/chalito/pull/4) | the real Claude Code run (`scripts/e2e-claude.md`) | D-002, D-039 |
| M4 Codex (+ Grok Build ACP) | Done | [#5](https://github.com/picassoglitch/chalito/pull/5) | OpenAI Sign in with ChatGPT approval | D-003, D-022 |
| Data layer on Supabase (ADR 0017) | Done | [#6](https://github.com/picassoglitch/chalito/pull/6) ([#3](https://github.com/picassoglitch/chalito/pull/3) closed) | nexo-ai sign-off + migrations (Phase 2) | D-048–D-053 |
| M5 Web/PWA + onboarding | Code-complete, owner-gated | [#7](https://github.com/picassoglitch/chalito/pull/7) | Vercel project, env, domain (Phase 6) | D-055, D-056 |
| M6 Escalation + comms | Code-complete, owner-gated | [#8](https://github.com/picassoglitch/chalito/pull/8) | Twilio number + Verify, Meta template, the one real call + template (Phase 5, 8.3) | D-013, D-050 |
| M7 Desktop companion + animation | Code-complete, owner-gated | [#11](https://github.com/picassoglitch/chalito/pull/11) | signed builds (M14) | D-059 |
| M8 Avatars + pay-to-dress store | Code-complete, owner-gated | [#14](https://github.com/picassoglitch/chalito/pull/14) | cosmetic prices; hub `store.purchase` (Phase 0.1, 1.5) | D-030, D-057, D-060 |
| M9 Mesa + token efficiency | Code-complete, owner-gated | [#13](https://github.com/picassoglitch/chalito/pull/13) | AI provider keys, KMS (Phase 3, 5.1) | — |
| M10 MCP gateway | Code-complete, owner-gated | [#12](https://github.com/picassoglitch/chalito/pull/12) | `mcp.` domain mapping (4.5) | — |
| M11 Rooms + messaging + portal scene | Code-complete, owner-gated: rooms on web (`/salas`, `/r/[id]`) and desktop, the deterministic portal scene (`packages/scene`, RoomScene) with co-members' avatars and cosmetics, render quality on the room and the pet | [#9](https://github.com/picassoglitch/chalito/pull/9) | load test at 1k (Phase 10) | — |
| M12 Hub billing integration | Code-complete, owner-gated | [#10](https://github.com/picassoglitch/chalito/pull/10) | hub `/usage/admit` + `/usage/settle` on chalyb `main` (§7b), Solo MXN amounts, trial/Solo reporting | D-016, D-026, D-030, D-031 |
| M13 Solo landing (real renders) | Code-complete (branch `m13-landing-8d`; the app's home moves to `/inicio`) | — | Solo MXN amounts for checkout (Phase 0.2) | D-031 |
| M14 Downloadable apps | Code-complete, owner-gated | [#16](https://github.com/picassoglitch/chalito/pull/16) | updater key, Apple, Azure, the publish go (Phase 9) | D-011, D-061 |
| M15 Hardening + docs | Code-complete (on `all` via `m15-hardening`, no separate PR), owner-gated | — | the 1k load test, legal review (Phase 10) | D-060 |
| M16 Chalito Link (ADR 0022) | In progress (owner go 2026-10-15): A efficiency, B link format, C links, D connect, E LAN | per phase | A2A server domain (#36), TURN relay (#37) | — |
| First Run (ADR 0028) | Proposed (docs, 2026-10-16); ships before M17 | per phase | `api.` domain mapping (#49), Apple secrets, updater key, releases.tf, the publish go | — |

**Security fixes from the beta review** (`docs/reviews/beta-security-review.md`): [#17](https://github.com/picassoglitch/chalito/pull/17) R-C1 (critical), [#18](https://github.com/picassoglitch/chalito/pull/18) R-H2, [#19](https://github.com/picassoglitch/chalito/pull/19) R-L12 adapters env, [#20](https://github.com/picassoglitch/chalito/pull/20) R-M1 + revoke guard. The other findings were fixed on `all` in M15 (batches 2–3) and by the review owners.

## Milestones

### M0: Planning (this commit)
- **Status:** done. The first commit on `main`.
- **Delivered:**
  - `docs/VERIFIED_APIS.md`, this plan, 16 ADRs, `docs/THREAT_MODEL.md`, `DEVIATIONS.md`.
  - `packages/protocol` zod schemas plus 18 schema tests: typecheck clean, tests green in an isolated scratch install.
  - `packages/config/plans.yaml`, validated by `PlansConfig`.
- **Review asks:** the protocol shapes below, `plans.yaml`, and the owner decisions at the end.

### M1: Foundations + brand
- **Status:** done. PR #1 (`m1-foundations`), CI green, waiting for the owner's merge.
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
- **Status:** done. PR #2 (`m2-control-plane`, stacked on #1), CI green including the emulator job, waiting for the owner's merge. Nothing applied to live cloud. WebAuthn registration moved to M5 (D-034).
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
- **Status:** in progress on `m3-agent` (stacked on M2).
  - Done: policy engine and classifier, Developer mode, signed trust store, approvals, Claude Code adapter with the fake Claude Code tests, Firestore store, service definitions.
  - In progress: the `chalito` CLI and daemon (`m3-cli`), the compiled-binary build (`m3-build`), and the classifier hardening from the security review (`m3-classify`; see `docs/reviews/m3-security-review.md`).
  - Still to do: the real run in `scripts/e2e-claude.md`.
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

### M16: Chalito Link (ADR 0022)
- **Scope:** one language for every AI, in phases, one branch and PR each:
  - **A `m16a-efficiency`:** session idle-close and resume after restart, partial text streaming (`message.assistant.delta`, broadcast-only), fast live path (sealed broadcast plus batched inserts), computer-control MCP for ACP sessions, Cursor ACP probe.
  - **B `m16b-link-format`:** `packages/protocol/src/link.ts` (`LinkTask`, `LinkMessage`, `LinkArtifact`, `AgentCard`) shaped like A2A v1, plus the `AdapterEvent` → `LinkTask` projection.
  - **C `m16c-links`:** `AgentLink` with **share** and **hand-off** modes, origin `agent:<sessionId>` (relayed), hand-off links created only locally, confirm-each-time by default, hop limit of 2, budgets, audit, revoke-all.
  - **D `m16d-connect`:** recipe drivers `chat-api` (OpenAI-compatible) and `a2a` (client), Chalito as an A2A server (off by default), MCP gateway `list_agents`/`create_task`.
  - **E `m16e-lan`:** mDNS discovery plus device-key mutual auth, local WebSocket for sealed envelopes, with cloud fallback.
- **AC:**
  - Existing suites stay green. The `SessionAdapter` conformance suite covers resume and the new drivers.
  - A: a terminal session writes at least 5× fewer `session_events` rows, and the phone sees deltas.
  - C: prompt-injection fixtures between agents (share mode never prompts; hand-off never auto-approves); loop fixture stops at 2 hops.
  - D: A2A conformance against the official SDK, pinned version.
- **Risks:**
  - A2A is young (v1.0, March 2026). Pin it and keep fixtures.
  - Hand-off widens the attack surface, so the threat model must be updated in C.
  - The A2A server is externally visible and TURN costs money; both need the owner's go.
  - **No browser automation of chat websites.**

### First Run (ADR 0028): installers, pairing without a terminal, autostart, guided setup
- **Why:** a new user today can activate one browser and reach Mesas, but can't get to a paired computer, a connected AI or a first task.
  - Nothing is downloadable (no release, `/releases/*/latest.json` 404, `/descargar` strings missing on hub `main`).
  - No screen claims a `chalito pair` code.
  - About eight setup steps need a terminal.
  - The built api base `api.chalito.chalyb.com` doesn't resolve.
- **Order:** before M17 (owner, 2026-10-16). One branch and PR per phase. A and B in parallel, then C, then D. We stop for "go" after each.
- **Where the UI lives:** the live screens are the hub port in the Chalyb repo:
  - pages in `src/app/[locale]/(dashboard)/app/chalito/`
  - components in `src/components/tools/chalito/`
  - strings in `src/lib/chalito/messages/{es,en}.json`

  `chalito/apps/web` is not what users see. Hub changes go in Chalyb PRs with the owner's go.

#### A `fr-a-installers`: installers you can download
- **Repos:** chalito (CI, desktop config, docs) and the hub (`/descargar`).
- **Files likely touched:**
  - `.github/workflows/release.yml` (api base stays `https://api.chalito.chalyb.com`; the stable channel refuses unsigned Windows);
  - `apps/desktop/src-tauri/tauri.conf.json` (CSP) and the CI release config overlay that adds `plugins.updater` (endpoint and public key; read at `src-tauri/src/lib.rs:344`);
  - `apps/desktop/scripts/release/*`;
  - `infra/terraform/envs/dev/releases.tf` (unchanged, applied by the owner);
  - hub: the Descargar page and component, plus `src/lib/chalito/messages/{es,en}.json`. Merge or cherry-pick `chalito.download` from the unmerged hub branch `origin/claude/audit-hub-chalito`.
- **AC:**
  - `/descargar` detects macOS, Windows or Linux and shows one primary button, with the others below.
  - The Windows SmartScreen step is explained while Windows is unsigned.
  - Checksums are shown.
  - A dry run of `release.yml` builds all three OSes with real account wiring, labelled correctly.
  - The first beta release installs and signs in on macOS (signed and notarized), Windows (unsigned, beta) and Linux (AppImage and deb).
  - The installed app's updater finds `latest.json` through `api.chalito.chalyb.com`.
- **Tests:**
  - Unit tests for OS detection and manifest parsing on the hub page.
  - A hub test that `/descargar` renders every string (no raw keys).
  - A CI check that the CSP and the overlay's updater host equal `CHALITO_API_BASE`.
  - A release-script test that the **stable** channel refuses an unsigned Windows build (beta accepts it, labelled).
  - A manual three-OS install check, written up in `docs/QA_PLAN.md`.
- **Owner-only:**
  - The DNS record for `api.chalito.chalyb.com` and the Cloud Run domain mapping to service `chalito` (Search Console verification of `chalyb.com` if needed).
  - Apple secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY`).
  - The updater key secrets plus `TAURI_UPDATER_PUBKEY`.
  - `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` repository variables.
  - `releases.tf` apply, plus `CHALITO_RELEASES_BUCKET`/`SIGNER` on the api.
  - The tag, then reviewing the draft, then publishing (`docs/OPS.md` §10 step 6).

#### B `fr-b-pairing`: pairing a computer with no terminal
- **Repos:** chalito (agent IPC, desktop panel, api) and the hub (approval screen).
- **Files likely touched:**
  - `apps/agent/src/ipc-handlers.ts` (implement the existing `pendingPairing` and `confirmPairing` at 168-169, add `startPairing`);
  - `apps/agent/src/pair.ts` (shared ceremony, used by CLI and IPC);
  - `apps/desktop/src/panel/` (a new "Conectar esta computadora" view with glyph, fingerprint and reverse-check buttons; `GlyphView.tsx`, `Security.tsx`, `SignIn.tsx`);
  - `apps/desktop/src-tauri` (open the hand-off URL);
  - `apps/api/src/routes/pairing.ts`:
    - `/codes` records the requester's public IP and coarse location through `clientIp` (`@chalito/guard`);
    - new `GET /codes/:codeId` for the approval screen: any `requireAuth(["client"])` client, rate-limited, unclaimed and unexpired codes only, and no short code or keys in the answer (the same rule as `/resolve`);
    - `/claim` **rejects a network mismatch without the short-code proof**;
    - new `POST /decline` burns the code: the same rule, with its own rate limit;
  - pairing alerts to every device of the account ("Se conectó la computadora *X*", with revoke). This is new work: an outbox row from the api or a trigger into `chalito_private.notify_outbox`, delivered by `apps/notifier/src/notify-outbox.ts` and `apps/notifier/src/senders/push.ts`, with a template in `apps/notifier/src/template.ts`;
  - `packages/protocol` (an optional pairing hand-off field, `v` stays 1);
  - one Chalito migration plus pgTAP for the new pairing-code columns: IP and city purged with the code's TTL, and no read access for the agent's watch token (**numbers from the coordinator**);
  - hub: the new `/computadoras/aprobar` page, built on the existing `AddDevice.tsx`:
    - the codeId comes from the URL fragment (never the short code), and is kept in `sessionStorage` across the hub sign-in redirect;
    - camera scan or typing as the fallback;
    - "No estoy frente a esa computadora";
    - reuses `Activate` for a first-ever device, and endorsement for an untrusted browser.
- **AC:**
  - From a fresh install, the computer is paired with no terminal and no typing on the same machine: "Conectar esta computadora", then "Aprobar" with a passkey in the browser, then "Sí, fui yo" in the panel.
  - The fingerprint is shown on both sides.
  - A first-ever account activates its browser and pairs its computer in one flow.
  - A browser that isn't trusted can't approve.
  - A claim from a different public IP than the requester gets the warning state and must type the short code. The api refuses it otherwise, whatever the screen does.
  - "No estoy frente a esa computadora" burns the code.
  - The hand-off survives the hub sign-in redirect.
  - Every pairing alerts all the account's devices.
  - `chalito pair` still works and prints the approval link.
- **Tests:**
  - agent: IPC pairing tests, including reverse check "No" writes nothing;
  - api (where the mismatch rule is pinned): same-network one-tap, mismatch refused without the short code, decline burns the code, expired or claimed refused, rate limit, `clientIp` behind the proxy;
  - pgTAP (data only): the new columns, the purge, and the watch token can't read them;
  - notifier: a pairing alert reaches every device of the owner and none of another owner's;
  - hub: unit and Playwright tests for the approval screen (fragment never sent to the server; survives the sign-in redirect; only the codeId is in the fragment);
  - a rehearsal run of the full ceremony (`scripts/e2e-phone.ts` path, updated);
  - a new `docs/THREAT_MODEL.md` §4.5 row "Pairing phishing via hand-off link" and its pinning test.
- **Owner-only:** none beyond the hub PR go.

#### C `fr-c-takeover`: leave the PC on and Chalito takes over
- **Repos:** chalito (desktop and agent).
- **As built (2026-10-16):**
  - Start-with-the-computer is the app itself (tauri-plugin-autostart, on by default; switch in Ajustes → Esta computadora and in the tray). The app's supervisor then runs the agent. The OS service is **not** installed automatically: an agent started by the service makes the app's own agent exit "elsewhere", and the panel then has no IPC (its per-launch secret only reaches an agent the app started). `chalito service install` stays for headless computers.
  - Detection and "Usar" extend the connect engine (`apps.view()` carries each CLI's pin state and the sha256 shown; IPC `pinApp`), not a separate `adapters.detect`. `pinApp` pins only a file that still hashes to what the panel showed, read through one open descriptor; it refuses a world-writable file or folder. The daemon's exec-path check (`checkClaudePin`) applies the same folder rule and always re-reads the file; the panel's hash cache is display-only.
  - Workspaces: IPC `workspaces` / `addWorkspace` (the agent asks the OS itself, then signs a `local` policy change) / `removeWorkspace`; the folder picker is the native `pick_folder` command. Paths go through the OS realpath (symlinks, `..`, Windows 8.3 names), NFC, and case-folding on macOS/Windows; refused: the disk root, the home folder or above, ~/.chalito, credential folders (~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, ~/Library/Keychains, ~/.kube, ~/.docker…), startup/autostart/PATH folders (`policy/persistence.ts`, shared with the classifier, plus the agent's PATH) and their parents, system folders and another person's home. The classifier keeps writes to startup files and startup/PATH folders CRITICAL even inside a workspace (a project's own PATH entries such as node_modules/.bin excepted).
- **Files likely touched:**
  - `apps/desktop/src-tauri/Cargo.toml` and `capabilities` (`tauri-plugin-autostart`), plus the Rust setup and tray menu;
  - `apps/desktop/src/panel/Settings.tsx` (autostart switch, Avanzado → CLI on PATH);
  - `src-tauri/src/agent.rs` (installs the OS service after pairing, with one confirmation; keeps the supervisor until it runs);
  - agent service definitions (D-005);
  - a new agent IPC `adapters.detect` / `adapters.pin` (same checks as `chalito <x> pin`);
  - `apps/desktop/src/panel/Apps.tsx` ("Usar" next to each detected CLI; "se actualizó: confirmar" after a hash change);
  - a new IPC `policy.addWorkspace` from the OS folder picker (a local signed policy change).
- **AC:**
  - After install and pairing, a reboot brings Chalito back in the tray, with the agent online and no terminal.
  - Turning autostart off sticks.
  - Installed claude, codex, grok, gemini, aider, copilot-cli and cursor-cli are detected and pinned with one click each.
  - A self-updated binary asks to re-confirm.
  - A workspace folder is chosen from a picker and "Espacio de trabajo" in New Session lists it.
  - A remote client can't pin a binary or add a workspace without the local confirmation.
- **Tests:**
  - agent unit tests for detection paths per OS, pin refusal cases (world-writable, hash change), and `policy.addWorkspace` signing;
  - desktop panel tests (`apps/desktop/test/panel.test.tsx`);
  - Rust tests for the autostart toggle;
  - the manual three-OS reboot check in `docs/QA_PLAN.md`.
- **Owner-only:** none.

#### D `fr-d-guided`: a setup that is actually guided
- **Repos:** the hub (screens and strings) and chalito (panel checklist, agent state report).
- **Files likely touched:**
  - hub: `Home.tsx`, `Onboarding.tsx`, a new `SetupChecklist`, `Devices.tsx`, the New Session empty state, `ConnectProviders.tsx`, and `src/lib/chalito/messages/{es,en}.json`;
  - chalito: the agent presence payload (pinned adapters and workspace count; no paths), and the desktop panel checklist.
  - **As built:** `devices.presence.setup` = pinned app ids, folder count and folder *labels* (the labels already travel in session rows; the first task needs one). Strict schema `DeviceSetup` (`packages/protocol/src/presence.ts`) refuses anything path-like. A presence-only update doesn't fan out, so the hub re-reads every 15 s while the checklist is open. The checklist logic is one pure file shared by the hub and the panel (`packages/ui/src/setup.ts`, copied byte-for-byte to the hub).
- **AC:**
  - The checklist (Cuenta, Este navegador, Computadora, Una IA, Carpeta, Primera tarea) reads only real state and can't be marked done by hand.
  - It shows on Inicio and in the panel until all green.
  - `/bienvenida` skips go to "later", never "done".
  - The first task runs a LOW-tier summary in the chosen folder.
  - `/dispositivos` with no computer shows "Aún no conectas una computadora" plus Descargar.
  - The jargon is replaced or explained, per ADR 0028 §6, in ES and EN.
- **Tests:**
  - hub unit tests for checklist state derivation, plus a Playwright happy path on a fresh account (the hub's Playwright gets its first Chalito spec);
  - the brand lint on the new copy;
  - an agent test that the presence payload carries no paths.
- **Owner-only:** none beyond the hub PR go.

- **Risks:**
  - Cloud Run domain mapping is Preview. The fallback is a global external ALB, which costs money monthly (owner's go).
  - Windows SmartScreen while unsigned.
  - Autostart and service install differ per OS and per Linux desktop.
  - Detecting CLIs across install methods (Homebrew, npm global, native installers).
  - The pairing-phishing residual risk (ADR 0028 §4).
- **Follow-ups:**
  - Windows has no OS prompt the agent can call before panel pairing (`os-auth.ts`): the panel's per-launch IPC secret and the local "Sí, fui yo" are the only local proof there. Add Windows Hello through `Windows.Security.Credentials.UI.UserConsentVerifier` from the desktop app (Tauri side) and require it for panel pairing, as macOS and Linux do with their system prompts.

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
| 24 | Windows signing | **Owner (2026-10-16): unsigned for internal/beta, then Azure Artifact Signing before the public launch** (OV certificate if not eligible; ADR 0028) |
| 25 | Front door | **Owner: Vercel** (ADR 0015) |
| 26 | Codex ChatGPT plan | **Owner: make it work.** Official SIWC, `owner_only` until OpenAI approves (D-003) |
| 27 | Grok Build login | **Owner: on** (D-022) |
| 28 | Unsigned origins default | Accepted: on, tightenable |
| 29 | Spoken PIN on calls | **Owner: feature toggle, default off** |
| 30 | Firestore location | Accepted: `us-central1` (named database `chalito`) |
| 31 | **New:** MXN charge amounts for the Solo USD ladder on the hub | Unset; Solo checkout "Disponible pronto" until set |
| 32 | **New:** Hub changes for Chalito meter kinds + `store.purchase` | Proposed for the Chalyb PR at M2/M12 (D-030) |
| 33 | **New:** Add Firebase to Chalyb's GCP project (custom-token sign-in, rules deploy) | Off until the owner says so (`enable_firebase = false`) |
| 34 | **New (2026-10-15):** agent-to-agent | **Owner: both modes** (share and hand-off links, ADR 0022 §3) |
| 35 | **New (2026-10-15):** M16 order | **Owner: all phases A–E** (no browser automation) |
| 36 | **New:** A2A server public domain | Pending (off until set) |
| 37 | **New:** TURN relay for remote screen | Pending (costs money) |
| 48 | **New (2026-10-16):** First Run milestone | **Owner: ships before M17** (ADR 0028) |
| 49 | **New (2026-10-16):** desktop api base | **Owner: `api.chalito.chalyb.com`** via DNS + Cloud Run domain mapping, run by the owner (amends ADR 0015's update) |
| 50 | **New (2026-10-16):** autostart | **Owner: on by default**, with a switch in the panel and tray |
| 51 | **New (2026-10-16):** pairing on a network mismatch | **Owner: allowed if the user types the short code** (enforced by `/claim`). Residual risk accepted: the attacker can send the code too; mitigations are the plain warning, the decline button and alerts to all devices. Block on mismatch was rejected (ADR 0028 §4) |
| 52 | **New (2026-10-16):** what proves "same computer" for one-tap pairing | **Owner: the agent's loopback proof only** (127.0.0.1, hub origin, the api's single-use nonce for that browser, ADR 0028 §4). A public IP isn't proof (CGNAT, offices, cafés): it stays as warning text only. Without the proof the user types the short code |
| 53 | **New (2026-10-16):** which hub plans include Chalito | **Owner: Pro and VIP only.** Gratis has no Chalito (`packages/config/plans.yaml` `hubTiers.free.access: none`), matching the hub engine row (`tier_required` PRO). Gratis sees "Chalito viene en Pro" with the trial or the plans. Supersedes the 2026-10-06 "Gratis gets every feature on Lite" decision |
