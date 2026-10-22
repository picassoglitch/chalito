# ADR 0030: "Use ours, pay us" for coding agents

Status: accepted (owner decision 2026-10-21)

## Context

A person connects each coding agent with their own API key or their own plan sign-in. The owner
wants a third option: "either you connect your ai account or pay us to use ours". Chalyb's keys
run the agent and the usage is charged to the person's Chalyb tokens like any other managed work.

Anthropic's terms forbid it for Claude Code: "Customers may not pay for, resell, or intermediate
Claude usage on their end users' behalf" (docs/VERIFIED_APIS.md, Claude section). The owner: "then
lets do what [Anthropic] says we should do, lets not create friction". Claude Code stays on the
person's own key or own login. Anthropic isn't contacted now, and there's no OpenCode workaround.

Checked in the CLIs' source (2026-10-21) that each can point at our own base URL with a token of ours:

| Agent | How it reaches the gateway | Wire |
| --- | --- | --- |
| Codex 0.163 | `-c model_providers.chalito_managed.{base_url, env_key, wire_api="responses", requires_openai_auth=false, supports_websockets=false}`; bearer from `env_key`; never calls `/models` with a custom base | `POST {base}/responses` (SSE, usage in `response.completed`) |
| Gemini CLI 0.61 | `GOOGLE_GEMINI_BASE_URL` (HTTPS) with ACP `authenticate {methodId: "gemini-api-key", _meta: {"api-key": token}}`; key in `x-goog-api-key` | `POST {base}/v1beta/models/{m}:streamGenerateContent?alt=sse`, `:generateContent`, `:countTokens` |
| Grok Build 1.0.46 | `GROK_MODELS_BASE_URL` with `XAI_API_KEY` = token in a fresh `GROK_HOME` (a cached `grok login` wins over the key) | `GET {base}/models` at start, `POST {base}/responses` |

Grok's ACP key path against a custom base is not verified end to end; it ships behind the same
switch and is checked on staging before the switch goes on.

## Decision

### Scope
- "IA de Chalyb" for Codex, Gemini CLI and Grok Build, never Claude Code (providers.yaml
  `codingAgents.*.managed`; the schema refuses a `managed` block on claude-code).
- Paid hub tiers only: Pro and VIP (`codingManaged.tiers`, read from `users.tier`).
- Global switch `CODING_MANAGED_ENABLED=1` on the api and the gateway. Off by default; off means
  no credential is issued and every gateway request is 503 `managed_disabled`.

### Keys stay on our side
- New service `apps/ai-gateway` (Cloud Run). It alone holds the provider keys (Secret Manager),
  from provider projects used for nothing else, with their own spend alerts.
- The agent asks the api for a per-session credential: `POST /v1/coding/credentials {sid, agent}`
  with its device token. The answer has an opaque token (`chc_` + 32 random bytes, base64url),
  the gateway URL, the allowed models and the expiry. Only the token's SHA-256 is stored
  (`chalito_private.coding_credentials`, the mcp-gateway pattern). The token is bound to owner,
  device, sid, agent, provider and the model allowlist, lives at most `credentialTtlSeconds`, and is
  revoked on session end (`DELETE /v1/coding/credentials/:id`), re-issue, kill switch, device
  revoke and expiry.
- The agent puts the token in the CLI's environment after the allowlist (R-L12), in Chalito's own
  CLI home, never in logs, events or the session card. The token is never logged by the api or
  the gateway (only the credential id).

### Metering (the hub contract, no new hub routes)
- Issue: the api checks switch, tier and the live-session limit (`sessions.yaml`
  `maxLivePerDevice` live credentials per device), then admits a stream hold
  (`class: stream`, `operation: coding.session`, `external_job_id: coding:<credential>:<gen>`).
  A refusal is 402 `out_of_energy` (`no_tokens`) or 429 `managed_busy` (`concurrency`,
  `streams_cap`).
- Before each upstream request the gateway, holding the credential row lock:
  1. refuses a model outside the allowlist (400) and clamps the output limit to
     `managed.maxOutputTokens` (Codex never sends one; the gateway sets it);
  2. prices the worst case from prices.yaml: input ≤ request body bytes (a token is at least one
     byte), output = the clamped limit;
  3. checks the daily cap: today's spend (owner local day, `users.tz`) in billable tokens at the
     hub's 160% ≥ cap → 402 `daily_cap`;
  4. re-admits the same hold with `est_tokens = reserveTokens(unsent + in-flight + worst case)`
     (pre-margin; the hub adds the margin). "Unsent" is this credential's usage still pending in
     the outbox, which the hub can't see yet. `no_tokens` → 402 `out_of_energy`. An expired hold
     (`already_settled`) is replaced by a new one (`gen + 1`).
- After the response: usage from the provider's own numbers (`response.completed` usage, Gemini's
  last `usageMetadata`), priced from prices.yaml, written in one transaction: an `llm.tokens`
  event in `usage_outbox` (origin `session.managed`, `source_id coding:<credential>:<seq>`, tied to
  the hold), the day's row in `coding_spend_daily`, the credential's totals. If the person's CLI
  disconnects, the gateway keeps reading the provider stream to its end so the usage is known. If
  the provider never reports usage, the request is billed at its worst-case input plus the output
  bytes streamed, marked `estimated`.
- Settle `succeeded` when the credential is revoked or expires (the gateway's sweep, every minute).
- The hub applies the margin. Chalito only ever sends provider cost. A request is billed once
  (idempotent `source_id`), and only through the outbox, never a second path.

### Out of tokens or over the cap
- The request in flight finishes. The next one gets 402 with `{error: "out_of_energy" | "daily_cap"}`
  and the credential records `blocked_reason`. The agent reads it after the turn
  (`GET /v1/coding/credentials/:id`) and emits `session.blocked {reason}`. The hub shows the
  recharge chip and "Usar mi clave". A later request passes again once the balance or cap allows.

### Daily cap
- `chalito.coding_settings.daily_cap_tokens`; unset means `codingManaged.dailyCap.default`
  (1,250,000 billable tokens, about five dollars). Lowering is free. Raising needs a passkey
  step-up (`verifyStepUp`) and stops at the tier's `ceiling`.

### Abuse
- Per-token and per-IP token buckets on the gateway, the live-credential limit, the model
  allowlist, the output clamp, and the kill switch.

### Hub UI (chalyb)
- Per agent: "IA de Chalyb" / "Mi clave" / "Mi plan". Claude Code has no Chalyb option and a short
  note why. Daily cap in Ajustes; an "Agentes de código" line in Uso; the out-of-energy chip on
  the session page.

## PR sequence
B1 this ADR and the config → B2 migration (coding_credentials, coding_settings, coding_spend_daily,
RLS) → B3 billing (billable origin, `localDayStart`, CodingMeter) → B4 api (credentials, settings,
step-up) → B5 apps/ai-gateway → B6 agent and adapters (the `chalyb` connect method,
`session.blocked`) → B7 hub UI → B8 ops runbook.

## Consequences
- A person can copy the token out of the CLI's environment and call the gateway with another tool.
  It is still their session's allowlist, their balance and their cap, until the session ends.
- The hub's per-tier stream caps apply: Pro has one active stream (shared with desktop voice),
  VIP five. A second managed session on Pro is refused as busy until the hub's caps change.
- One request can exceed the cap or the balance by at most its own worst case; the next is refused.
- Only priced models can be allowed. Better coding models need verified prices first.
