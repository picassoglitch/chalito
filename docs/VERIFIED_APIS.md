# Verified APIs

Checked on **2026-10-03** against official docs, package type definitions (`npm pack` of the published tarballs) and source (shallow clone of `openai/codex` at 3e238776). Every fact carries its source URL. **UNVERIFIED** marks anything we could not confirm from a primary source. Where the brief and the docs disagree, the docs win and the deviation is logged in `/DEVIATIONS.md`.

## Headline findings that change the plan

| Area | Finding | Effect |
|---|---|---|
| Claude Code BYO | The Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." | Claude Code BYO is **API key only** (decision #19 resolves to the safe default). The env is pinned so the CLI never falls back to `/login`. |
| Agent SDK | 6 permission modes (`default, acceptEdits, bypassPermissions, plan, dontAsk, auto`). Omitting `permissionMode` may resolve to `auto` (≥0.3.286). `canUseTool` never fires for auto-approved calls; PreToolUse runs on every call (600 s default timeout). | The adapter always passes `'default'`. The policy gate is a PreToolUse hook with timeout > 10 min. Remote modes are limited to `default/plan/acceptEdits`. |
| Agent SDK packaging | No `cli.js`; it spawns a ~245 MB native `claude` binary. | The agent uses the user's installed Claude Code (`pathToClaudeCodeExecutable`), see ADR 0004. |
| Codex BYO | "App-server authentication has never been permitted for commercial or hosted services." Sign in with ChatGPT for paid apps is waitlist-gated. app-server is "experimental". | Codex uses the official SIWC flow (owner: "make it work"), `owner_only` until OpenAI approves, plus API key (D-003). Version pinning plus a conformance suite. |
| Codex protocol | JSONL, no `jsonrpc` field. `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` → `{decision: accept\|acceptForSession\|decline\|cancel}`. Sandbox `read-only\|workspace-write\|danger-full-access`. | `RemoteCodexSandbox` = `read-only\|workspace-write`. |
| Grok Build | Exists; `grok agent stdio` speaks ACP. A Grok Build login draws on the user's Grok subscription. No terms for third-party embedding. | Owner: Grok Build login on, plus API key (D-022). |
| Realtime | `gpt-realtime-2.1-mini` exists ($10/$20 per 1M audio tokens). `client_secrets`, `/v1/realtime/calls`, SIP and `realtime.call.incoming` all confirmed. GPT-Live is OpenAI's new lead voice product. | As specified. GPT-Live noted as a future adapter. |
| Twilio → OpenAI SIP | Programmable Voice `<Dial><Sip>` works without Elastic SIP Trunking (Twilio tutorial). OpenAI requires TLS + SRTP. | `;transport=tls;secure=true`. Media Streams fallback kept. |
| WhatsApp | Graph **v26.0**. Since **2026-10-01** utility messages are billed even inside the 24 h window (MX USD 0.0085). Unverified businesses are limited to 250 recipients/day. | Cost model updated. Business verification is an early OPS task. |
| Twilio voices | No Google es-MX voices; use `Polly.Mia-Neural`. Gather's `phone_call` model lacks es-MX. | Config defaults set accordingly. |
| FCM | `getToken()` deprecated → `register()`/`onRegistered()` with Firebase Installation IDs. | Web push uses the new API. |
| Firestore TTL | Typically deleted **within 24 h**. TTL deletes are billed. | Clients filter `expireAt`. |
| Region | Cloud Tasks and Vertex gen-AI are not in `northamerica-south1`. Cloud Run domain mapping is Preview, us-central1 yes / us-south1 no. | **us-central1** in Chalyb's project. Web on Vercel (ADR 0015). |
| Cheap model | `gemini-2.5-flash-lite` retires 2026-10-20. `gemini-3.1-flash-lite` ($0.25/$1.50) is global/multi-region only. Regional +10% applies to Gemini 3+. Haiku 4.5 may retire after 2026-10-15. | `models.yaml` router = `gemini-3.1-flash-lite@global`, fallback `gpt-6-luna`. Haiku 4.5 is not a hard dependency. |
| Stripe | Trial Offer API not supported in Checkout (legacy `trial_end` still is). An MX account settles MXN only, and Adaptive Pricing needs the price currency to be a settlement currency. OXXO/SPEI can't do subscriptions. Sandboxes over test mode. | **Moot:** the owner chose the Chalyb hub (Mercado Pago), no Stripe (ADR 0012). Kept for reference. |
| MCP | Spec **2026-07-28**: CIMD SHOULD, DCR deprecated, RFC 9728/8707/9207. TS SDK v2 split packages. Claude connectors work on Free (1). ChatGPT Developer mode: Plus/Pro/Business/Enterprise/Edu; "Apps" are now "Plugins". | ADR 0009. |
| Identity Platform | MFA = SMS + TOTP, `MANDATORY` state exists. **No native passkeys.** | Moot for sign-in: accounts come through Chalyb hub SSO. The second factor is a Chalito WebAuthn passkey verified by the device (D-019, D-027). |
| Tauri | 2.12.1. `macOSPrivateApi` no-op. No per-pixel hit-test; `cursorPosition()` returns (0,0) on native Wayland. EV no longer bypasses SmartScreen. Artifact Signing (ex-Trusted Signing). `APPLE_PASSWORD` (not `APPLE_APP_SPECIFIC_PASSWORD`). | ADR 0014, D-006, D-011. |
| Chalyb hub (internal) | Engine contract: HMAC-SHA256 SSO launch token (300 s), `POST /tenants` (409 = success), `/usage/admit` → reservation + lane, `/usage` (≤100 events, `cost_usd_micros` required, idempotent `source_id`), `/usage/settle`. Billable = cost × (1 + margin 160%) at $4/1M. | Chalito integrates as engine `chalito` (ADR 0016). |
| Agent packaging | Node 22 SEA experimental and CJS-only; keytar archived; a Windows Service can't read user credentials. | bun `--compile`, `@napi-rs/keyring`, per-user Scheduled Task (ADR 0004). |


---

## Anthropic: Claude Agent SDK, subscription rules, connectors, caching

Method: official docs (code.claude.com, platform.claude.com, claude.com/docs, anthropic.com/legal, modelcontextprotocol.io) plus the published `@anthropic-ai/claude-agent-sdk` tarball (`npm pack --ignore-scripts`, read `sdk.d.ts`). 

### 1. `@anthropic-ai/claude-agent-sdk` (TypeScript)

#### Version
- `latest` = **0.3.288** (published 2026-10-03), `next` = 0.3.289. The package bundles Claude Code CLI **2.1.288** (`package.json` `claudeCodeVersion`), with the native binary shipped through per-platform `optionalDependencies` (`@anthropic-ai/claude-agent-sdk-linux-x64`, etc.). Source: `npm view @anthropic-ai/claude-agent-sdk` / tarball package.json (checked 2026-10-03)
- License: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." This is proprietary, not OSS. Use is governed by the Commercial Terms "including when you use it to power products and services that you make available to your own customers and end users". Source: tarball LICENSE.md; https://code.claude.com/docs/en/agent-sdk/overview (checked 2026-10-03)
- Installs that skip optional deps (`npm ci --omit=optional`) get no binary. In that case set `pathToClaudeCodeExecutable`. Source: https://code.claude.com/docs/en/agent-sdk/quickstart (checked 2026-10-03)

#### `query()`
- `export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options; }): Query;` Source: sdk.d.ts L3246 (checked 2026-10-03)
- `Query extends AsyncGenerator<SDKMessage, void>`. Its control methods "are only supported when streaming input/output is used", which means `prompt` must be an AsyncIterable. They are `interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `setMcpPermissionModeOverride(server, 'default'|'auto'|null)` (tighten-only), `close()` and others. Source: sdk.d.ts L2845-2900 (checked 2026-10-03)
- Options relevant to Chalito: `canUseTool`, `hooks`, `permissionMode`, `allowDangerouslySkipPermissions`, `permissionPrompts?: 'host'|'none'`, `permissionPromptToolName`, `allowedTools`/`disallowedTools`, `tools`, `resume`, `sessionId`, `forkSession`, `continue`, `persistSession`, `settingSources`, `managedSettings`, `env`, `cwd`, `additionalDirectories`, `mcpServers`, `strictMcpConfig`, `model`, `toolConfig.askUserQuestion.previewFormat`, `onUserDialog`, `includeHookEvents`, `pathToClaudeCodeExecutable`, `sessionStore`. Source: sdk.d.ts Options (L1580-2260) (checked 2026-10-03)

#### `canUseTool`
- Signature: `type CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; mcpServer?: {name, source}; decisionReason?: string; title?: string; displayName?: string; description?: string; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean; toolUseID: string; agentID?: string; requestId: string; matchedAskRule?: {...} }) => Promise<PermissionResult | null>`. Returning `null` is only for cases where the host already sent the control_response out-of-band, for example "a signed HTTP POST echoing `requestId`". An accidental null "means no control_response is sent and the tool stays blocked indefinitely — permission prompts have no park deadline." Source: sdk.d.ts L205-300 (checked 2026-10-03)
- Return type:
  ```ts
  type PermissionResult =
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: ... }
    | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: ... };
  ```
  `PermissionUpdate` is one of `addRules | replaceRules | removeRules` (`rules`, `behavior`, `destination`), `setMode` (`mode`, `destination`) or `addDirectories | removeDirectories`. The possible `destination` values are `'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'`. Source: sdk.d.ts L2507-2560 (checked 2026-10-03)
- `updatedInput` is optional on allow from CLI v2.1.207. Earlier versions rejected an allow without it. Source: https://code.claude.com/docs/en/agent-sdk/user-input (checked 2026-10-03)
- "The callback never fires for auto-approved tools." That covers allow rules, `acceptEdits`, `bypassPermissions` and bare `allowedTools` entries. The docs add: "For logic that must apply to every tool call, use a PreToolUse hook." The SDK emits the process warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` when `bypassPermissions` or bare `allowedTools` would shadow the callback. Source: https://code.claude.com/docs/en/agent-sdk/permissions (checked 2026-10-03)
- "The callback can stay pending indefinitely." For long waits, docs recommend a PreToolUse hook that returns `defer`, so the process can exit and resume later. Source: https://code.claude.com/docs/en/agent-sdk/user-input (checked 2026-10-03)
- A `Notification` hook with type `permission_prompt` fires once a permission request has waited about 6 seconds on `canUseTool` (TS SDK ≥0.3.233). Source: https://code.claude.com/docs/en/agent-sdk/hooks (checked 2026-10-03)

#### Permission evaluation order
- The order is: 1 Hooks → 2 Deny rules → 3 Ask rules → 4 Permission mode → 5 Allow rules → 6 `canUseTool`.
  - "A hook that returns `allow` does not skip the deny and ask rules below."
  - Deny rules block "even in `bypassPermissions` mode".
  - Ask rules, `AskUserQuestion`, and MCP tools with `_meta["anthropic/requiresUserInteraction"]` "always fall through to the callback", even in bypass mode or when an allow rule matches.
  - In `dontAsk` mode the callback step is skipped and the call is denied.
  - Source: https://code.claude.com/docs/en/agent-sdk/permissions (checked 2026-10-03)

#### Hooks / PreToolUse
- Callback: `HookCallback = (input: HookInput, toolUseID: string | undefined, { signal: AbortSignal }) => Promise<HookJSONOutput>`. Matcher: `{ matcher?: string; hooks: HookCallback[]; timeout?: number /*seconds*/ }`. Source: https://code.claude.com/docs/en/agent-sdk/hooks (checked 2026-10-03)
- Input: `PreToolUseHookInput = BaseHookInput & { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: unknown; tool_use_id: string; mcp_server?: McpServerProvenance }`. All hooks share `session_id`, `cwd`, `hook_event_name`, plus `agent_id`/`agent_type` when the hook runs in a subagent. Source: sdk.d.ts L2740 (checked 2026-10-03)
- Output: `{ hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision?: 'allow'|'deny'|'ask'|'defer'; permissionDecisionReason?: string; updatedInput?: Record<string,unknown>; additionalContext?: string } }`. Top-level fields include `continue`, `systemMessage`, `stopReason`, `suppressOutput`. Return `{}` to pass through. Source: sdk.d.ts L2748, L9614 (checked 2026-10-03)
- **Yes, PreToolUse runs for all tool calls**, including ones that the mode or settings would auto-allow. The docs say: "hooks run before every other step, and a hook deny applies even in `bypassPermissions` mode." In bypass mode, "Hooks still execute and can block operations if needed." Limits:
  - A hook `allow` cannot override deny or ask rules.
  - A hook `allow` cannot approve `rm`/`rmdir` on critical paths.
  - Hooks may not fire when `maxTurns` ends the session.
  - Source: https://code.claude.com/docs/en/agent-sdk/permissions ; https://code.claude.com/docs/en/agent-sdk/hooks (checked 2026-10-03)
- Precedence when several hooks or rules apply: "`deny` takes priority over `defer`, which takes priority over `ask`, which takes priority over `allow`." Hooks run in parallel. Source: https://code.claude.com/docs/en/agent-sdk/hooks (checked 2026-10-03)
- What the decisions do:
  - `ask` routes the call to the user prompt, which means `canUseTool`.
  - `defer` ends the turn with `stop_reason: "tool_deferred"`, and the call can be resumed later. `updatedInput` is ignored with `defer`.
  - Source: same (checked 2026-10-03)
- Timeouts: the default is 600 s for PreToolUse. On timeout the tool does not run, Claude gets a timeout tool result, and the turn continues (CLI ≥2.1.210). **Chalito's phone-approval wait must set `timeout` higher, or use `defer`.** Source: same (checked 2026-10-03)
- Hooks from settings files (shell/http hooks) also load when `settingSources` includes the source, which is the default. Source: same (checked 2026-10-03)

#### Permission modes
- `type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. Source: sdk.d.ts L2484 (checked 2026-10-03)
  - `dontAsk` denies anything that would prompt and never calls `canUseTool`.
  - `auto` uses a model classifier that allows or blocks, "prompting through canUseTool when it cannot decide".
  - `bypassPermissions` requires `allowDangerouslySkipPermissions: true`, and it refuses to start as root or under sudo outside a recognized sandbox.
- **Default changed.** When `permissionMode` is omitted, Claude Code uses a `permissions.defaultMode` from the loaded settings, "else `'auto'` where that is the default". The docs say: "Before TypeScript Agent SDK v0.3.286, omitting `permissionMode` was the same as passing `default`." **Chalito must pass `permissionMode: 'default'` explicitly** to keep every approval on the phone. Source: sdk.d.ts L1980-1995; https://code.claude.com/docs/en/agent-sdk/permissions (checked 2026-10-03)
- Runtime change: `await q.setPermissionMode('acceptEdits')`, streaming input only. "The new mode takes effect immediately for all subsequent tool requests." A `PermissionUpdate` of type `setMode` returned from `canUseTool` can also change the mode. Source: same (checked 2026-10-03)
- Subagents inherit the parent's mode. They run in `bypassPermissions` only if the parent does (CLI ≥2.1.267). Source: same (checked 2026-10-03)
- `permissionPrompts: 'none'` means nobody answers prompts and anything that would prompt is denied. Source: sdk.d.ts L2010-2018 (checked 2026-10-03)

#### Sessions: resume / fork / interrupt
- Session ID: `session_id` on every result message, and also on the init system message in TS. Source: https://code.claude.com/docs/en/agent-sdk/sessions (checked 2026-10-03)
- Session options:
  - `resume: string` resumes a session by ID.
  - `continue: true` resumes the most recent session in the cwd.
  - `forkSession: true` with `resume` creates a new session ID and leaves the original unchanged.
  - `sessionId` sets a custom UUID and cannot be combined with resume or continue unless forking.
  - `persistSession: false` keeps the session in memory only.
  - The standalone `forkSession(sessionId, opts)` function also exists.
  - Source: sdk.d.ts L838, L1709, L2087-2093; sessions doc (checked 2026-10-03)
- Storage: `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (or under `$CLAUDE_CONFIG_DIR`). Resume works only on the same machine unless a `SessionStore` adapter is used. Source: sessions doc (checked 2026-10-03)
- The V2 `createSession()` API was removed in TS SDK 0.3.142. Source: sessions doc (checked 2026-10-03)
- `interrupt(): Promise<SDKControlInterruptResponse | undefined>`, streaming input only. Newer CLIs return `{ still_queued: string[], ... }`. Interrupting during a pending PreToolUse callback cancels the tool call (CLI ≥2.1.208). Source: sdk.d.ts L2860, L4613; hooks doc (checked 2026-10-03)

#### AskUserQuestion
- AskUserQuestion is surfaced **through `canUseTool` with `toolName === "AskUserQuestion"`**. Input: `{ questions: [{ question, header (≤12 chars), options: [{label, description, preview?}] (2-4), multiSelect }] }`, with 1-4 questions per call.
- Answer by returning `{ behavior: "allow", updatedInput: { questions, answers: { [questionText]: label | label[] | "a, b" }, response?: string } }`.
- An allow rule never auto-approves it. It is denied in `dontAsk` mode, and it is not available inside subagents. If a `tools` list is given, it must include `AskUserQuestion`.
- Source: https://code.claude.com/docs/en/agent-sdk/user-input ; https://code.claude.com/docs/en/agent-sdk/permissions (checked 2026-10-03)

#### settingSources
- `type SettingSource = 'user' | 'project' | 'local'`. The d.ts says: "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode)." **So the user's `~/.claude/settings.json`, CLAUDE.md, skills, agents, commands and hooks ARE loaded by default.** Source: sdk.d.ts L2240-2252; https://code.claude.com/docs/en/agent-sdk/claude-code-features (checked 2026-10-03)
- The following are read regardless of `settingSources`:
  - managed policy settings and server-managed settings
  - `~/.claude.json`
  - auto memory (disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`)
  - claude.ai MCP connectors, when the session is authenticated with a claude.ai login (disable with `strictMcpConfig: true` or `ENABLE_CLAUDEAI_MCP_SERVERS=false`)
  - Source: same (checked 2026-10-03)

#### Auth
- Precedence used by the CLI, and therefore by the SDK:
  1. cloud provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, plus `CLAUDE_CODE_USE_ANTHROPIC_AWS`)
  2. `ANTHROPIC_AUTH_TOKEN` (Bearer)
  3. `ANTHROPIC_API_KEY` (X-Api-Key, always used in non-interactive mode)
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN` (1-year token from `claude setup-token`; needs Pro/Max/Team/Enterprise; model requests only)
  6. Anthropic profile / WIF
  7. subscription OAuth from `/login`, stored in `~/.claude/.credentials.json` on Linux/Windows and the Keychain on macOS
  - Source: https://code.claude.com/docs/en/authentication (checked 2026-10-03)
- "`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI and the surfaces that wrap it, including … the Agent SDK." So **technically the SDK falls back to the user's existing Claude Code `/login` credentials** if no env credential is set, because the SDK spawns the same CLI with the same config dir. Policy restrictions are in item 2. Source: same (checked 2026-10-03)
- The SDK does not load `.env` files. Source: quickstart (checked 2026-10-03)

### 2. Third-party use of Claude subscription (Free/Pro/Max) logins

Exact current texts:
- Agent SDK overview and quickstart (Note): "**Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.** Use the API key authentication methods described in the Quickstart instead." Source: https://code.claude.com/docs/en/agent-sdk/overview ; https://code.claude.com/docs/en/agent-sdk/quickstart (checked 2026-10-03)
- Legal and compliance, "Authentication and credential use":
  - "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - "… Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
  - Source: https://code.claude.com/docs/en/legal-and-compliance (checked 2026-10-03)
- Same page, "Can customers offer Claude Code in their products?": "preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms of Service and complying with the conditions below: **The Claude Code binary must not be modified.** … customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key). **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …" Source: same (checked 2026-10-03)
- Same page: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." Source: same (checked 2026-10-03)
- Consumer Terms (effective Oct 8, 2025) prohibit "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." Separately: "You may not share your Account login information … or Account credentials with anyone else." Source: https://www.anthropic.com/legal/consumer-terms (checked 2026-10-03)
- History (secondary sources, NOT official):
  - Jan 9, 2026: server-side blocking of subscription OAuth outside Claude Code.
  - Feb 19, 2026: a docs update said consumer OAuth tokens in third-party tools, "including the Agent SDK", violate the Consumer Terms.
  - Apr 4, 2026: Pro/Max access was blocked for third-party agentic tools.
  - The current official legal page wording differs from those quotes. It adds the "unmodified Claude Code binary" carve-out.
  - Source: https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ ; https://dev.to/mcrolly/anthropic-kills-claude-subscription-access-for-third-party-tools-like-openclaw-what-it-means-for-3ipc (checked 2026-10-03; UNVERIFIED against Anthropic primary sources)

**Conclusion.** For a PUBLIC Chalito built on the Agent SDK, the compliant BYO path is **API key only**: an Anthropic API key, `apiKeyHelper`, or a cloud provider credential, billed to the end user. Subscription login is not allowed unless Anthropic approves it in writing. The SDK-specific Note is explicit ("including agents built on the Claude Agent SDK"), and it is the more specific rule.

The legal page's carve-out ("end user signing in to the unmodified Claude Code binary with their own Claude subscription") is written for platforms that host or run the Claude Code CLI itself. Chalito spawns the bundled CLI via the SDK and would inherit the user's `/login`. That is plausibly inside the carve-out but conflicts with the SDK Note, so treat it as **ambiguous and not safe without approval**. Chalito must also never read, copy or relay `~/.claude/.credentials.json` or a `CLAUDE_CODE_OAUTH_TOKEN` (the "collect, store, or intermediate" ban).

Recommendation:
- Ship API-key BYO.
- Set `ANTHROPIC_API_KEY` explicitly in `options.env` so the CLI never falls back to the user's subscription login. Optionally set `CLAUDE_CONFIG_DIR` to an app-owned directory, or verify `apiKeySource` in the init message.
- Contact Anthropic sales for approval if subscription support is wanted.

### 3. Claude custom connectors (remote MCP)

- Plans: "Add a connector by URL … Works in **Free, Pro, Max, Team, and Enterprise** plans."
  - "On the Free plan, you can add one custom connector."
  - On Team/Enterprise, "an Owner adds the connector for the organization" (Enterprise custom roles too). Members then connect with their own account.
  - Source: https://claude.com/docs/connectors/custom/remote-mcp (checked 2026-10-03); also https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Auth types:
  - Supported by default: `oauth_dcr` (RFC 7591), `oauth_cimd` (Client ID Metadata Document) and `none`.
  - By arrangement: `oauth_anthropic_creds` and `custom_connection`, both via mcp-review@anthropic.com.
  - Beta for limited orgs: `static_headers`.
  - The UI options are "Use Claude's published identity" (CIMD, recommended), "Register automatically" (DCR) and "Use your own OAuth client".
  - `client_credentials` (M2M) is not supported.
  - Source: https://claude.com/docs/connectors/building/authentication (checked 2026-10-03)
- CIMD selection: Claude uses CIMD only if the authorization server metadata has `"client_id_metadata_document_supported": true` AND `"none"` in `token_endpoint_auth_methods_supported`. Otherwise it falls back to DCR. Source: same (checked 2026-10-03)
- Discovery requirements:
  - A `401` with `WWW-Authenticate: Bearer resource_metadata=...`. A `WWW-Authenticate` on a `200` is ignored.
  - RFC 9728 PRM whose `resource` equals the URL exactly. Only the first `authorization_servers` entry is used.
  - RFC 8414 or OIDC discovery.
  - S256 PKCE, and `code_challenge_methods_supported` must be advertised.
  - Source: same (checked 2026-10-03)
- Callbacks: `https://claude.ai/api/mcp/auth_callback` for the hosted apps. Claude Code uses a loopback `http://localhost:<any>/callback` and `http://127.0.0.1:<any>/callback`, with its CIMD at `https://claude.ai/oauth/claude-code-client-metadata`. Source: same (checked 2026-10-03)
- Token handling:
  - Refresh happens on 401 and proactively up to 5 minutes before expiry.
  - Rotate refresh tokens for public clients.
  - The `/token` endpoint must accept form-urlencoded.
  - Timeouts: 10 s for discovery/registration/token, 30 s for refresh.
  - Egress IP range is `160.79.104.0/21`.
  - Transport is Streamable HTTP; a URL ending in `/sse` selects legacy SSE.
  - Source: same; remote-mcp doc (checked 2026-10-03)
- MCP spec version:
  - The latest spec is **2026-07-28**. It uses OAuth 2.1 (draft-13) and adds RFC 9207 `iss` validation.
  - Client ID Metadata Documents are SHOULD.
  - **Dynamic Client Registration is MAY and "is deprecated and retained for backwards compatibility"**.
  - RFC 9728 PRM is MUST for servers and clients, and RFC 8707 `resource` is MUST.
  - Claude's connector docs still link spec **2025-11-25** for the CIMD, PKCE and token requirements.
  - Source: https://modelcontextprotocol.io/specification/latest ; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization ; https://claude.com/docs/connectors/building/authentication (checked 2026-10-03)

### 4. Prompt caching

- Shape: `"cache_control": {"type": "ephemeral", "ttl": "5m" | "1h"}`. `ttl` is optional and defaults to 5m.
  - Placement: per content block (explicit breakpoints, max 4 per request), or at the top level of the request ("automatic caching", which puts the breakpoint on the last cacheable block and moves it forward).
  - The lookback window is 20 blocks. Longer TTLs must come before shorter ones.
  - Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (checked 2026-10-03)
- Minimum cacheable tokens:
  - 512: Opus 5.5, Opus 5, Sonnet 5.5, Fable 5/5.1, Mythos 5/5.1
  - 1,024: Sonnet 5, Sonnet 4.6/4.5, Opus 4.8, Opus 4.1/4
  - 2,048: Opus 4.7
  - **4,096: Haiku 4.5**, Opus 4.6/4.5
  - A shorter prompt is silently not cached.
  - Source: same (checked 2026-10-03)
- Multipliers on base input:
  - 5m write is 1.25×.
  - 1h write is 2×.
  - Cache read is 0.1× (0.05× on Opus 5.5; 0.025× on Fable 5.1 and Mythos 5.1).
  - They stack with the Batch discount (50%) and the data residency multiplier (`inference_geo:"us"` is 1.1×).
  - Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03)

### 5. Model IDs and prices (USD per MTok)

Prices are per million tokens. Cache write columns are for 5m and 1h TTLs.

| Model | API ID (alias) | Input | Write 5m | Write 1h | Cache hit | Output | Context / max out |
|---|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` (`claude-haiku-4-5`) | 1 | 1.25 | 2 | 0.10 | 5 | 200K / 64K |
| Claude Sonnet 5.5 (latest Sonnet) | `claude-sonnet-5-5` | 2 | 2.50 | 4 | 0.20 | 10 | 1M / 128K |
| Claude Opus 5.5 (latest Opus) | `claude-opus-5-5` | 4 | 5 | 8 | 0.20 | 20 | 1M / 128K |
| Claude Fable 5.1 (top tier) | `claude-fable-5-1` | 10 | 12.50 | 20 | 0.25 | 50 | 1M / 128K |
| Claude Sonnet 5 (legacy) | `claude-sonnet-5` (UNVERIFIED id) | 2 | 2.50 | 4 | 0.20 | 10 | — |
| Claude Sonnet 4.6 (legacy) | `claude-sonnet-4-6` (UNVERIFIED id) | 3 | 3.75 | 6 | 0.30 | 15 | — |

- Haiku 4.5 retirement is "Not sooner than **October 15, 2026**", which is 12 days from today. Sonnet 5.5 is not sooner than Sep 28, 2027, and Opus 5.5 not sooner than Sep 22, 2027. Source: https://platform.claude.com/docs/en/about-claude/models/overview (checked 2026-10-03)
- Claude 4.6+ models get the 1M context at standard price (no long-context premium). The 4.7+ tokenizer produces about 30% more tokens. Batch is 50% off. Sonnet 5's $2/$10 is now the standard price. Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03)

### 6. Brand guidelines

- Agent SDK "Branding guidelines" (for partners): "use of Claude branding is optional."
  - **Allowed:** "Claude Agent" (preferred for dropdown menus); "Claude" when within a menu already labeled "Agents"; "{YourAgentName} Powered by Claude".
  - **Not permitted:** "Claude Code" or "Claude Code Agent"; "Claude Code-branded ASCII art or visual elements that mimic Claude Code".
  - "Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product."
  - Source: https://code.claude.com/docs/en/agent-sdk/overview (checked 2026-10-03)
- Legal page: "You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product." Other uses need written permission. Source: https://code.claude.com/docs/en/legal-and-compliance (checked 2026-10-03)
- Trademark Guidelines (last updated Aug 1, 2024): "You may only use our trademarks as specifically permitted by us and only in materials we approve beforehand." Contact marketing@anthropic.com. Source: https://www.anthropic.com/legal/trademark-guidelines (checked 2026-10-03)
- The name "Chalito" contains no Anthropic mark and is fine. Taglines like "runs Claude Code" in plain text are OK. Avoid Claude/Claude Code logos and look-alike UI.

### Deviations from the prompt
1. **Subscription login for BYO.** This is not allowed for a public Agent-SDK product without Anthropic approval. BYO must be API key (or cloud provider), and the env should be pinned so the CLI doesn't silently use the user's `/login`.
2. **Permission modes.** There are 6, not 4: `default, acceptEdits, bypassPermissions, plan, dontAsk, auto`. **The default is no longer `default`.** Since TS SDK 0.3.286, an omitted `permissionMode` can resolve to `auto` (classifier approvals), so pass `'default'` explicitly.
3. **`canUseTool` is not a universal gate.** It is skipped for auto-approved calls. Use a PreToolUse hook (no matcher) to sign or approve every call, keeping in mind that a hook `allow` doesn't override deny or ask rules.
4. **PreToolUse hook timeout.** The default is 600 s, and on timeout the tool does not run. Phone approvals need a larger `timeout` or the `defer` + resume pattern. `canUseTool` itself has no deadline.
5. **settingSources default.** This is NOT isolation. Omitting it loads user, project and local settings, including settings-file hooks and `permissions.defaultMode`, which can change the starting mode. Claude.ai connectors and auto memory load regardless.
6. **Control methods** (`setPermissionMode`, `interrupt`, `setModel`) require streaming input (AsyncIterable `prompt`).
7. **MCP spec.** The latest is **2026-07-28**, not 2025-06-18 or 2025-11-25. DCR is deprecated (MAY), CIMD is SHOULD, and RFC 9207 `iss` validation was added. Claude still supports DCR and CIMD and references 2025-11-25 in its docs.
8. **Custom connectors are available on Free too** (limited to 1). On Team/Enterprise only Owners (or Enterprise custom roles) can add them.
9. **Haiku 4.5's minimum cacheable prompt is 4,096 tokens** (not 1,024 or 2,048), and the model may retire after Oct 15, 2026. Don't hard-depend on it in prices.yaml.
10. **Opus 5.5's cache read is 0.05×** (not the standard 0.1×).
11. **The SDK is not open source.** It ships under Anthropic's legal agreements, and the Commercial Terms apply when shipping to end users.

### Unverifiable / open
- Whether Chalito's model counts as "end user signing in to the unmodified Claude Code binary": the SDK-bundled CLI running on the user's machine with the user's own `/login`. The SDK Note and the legal carve-out conflict. Needs written confirmation from Anthropic (sales). UNVERIFIED.
- The exact wording and dates of the 2026 OAuth crackdown (Jan 9 / Feb 19 / Apr 4) come only from secondary press. UNVERIFIED against Anthropic primary sources.
- The availability of `auto` mode per plan/account (docs say "where that is the default"). The exact conditions were not checked. UNVERIFIED.
- Model IDs for legacy Sonnet 5 and Sonnet 4.6 were not read from the docs table. UNVERIFIED.
- Which MCP protocol version string Claude's connector client negotiates (2025-11-25 vs 2026-07-28) is not stated. UNVERIFIED.
- The Python SDK was not checked; only the TS package was inspected.


---

## OpenAI: Codex app-server, Sign in with ChatGPT, Realtime, Developer mode; xAI

Method: read-only. Sources are official docs fetched on 2026-10-03, plus a shallow clone of github.com/openai/codex (HEAD 3e238776, committed 2026-10-03). npm `@openai/codex` latest = 0.160.0. Note: `developers.openai.com/codex/*` now redirects (308) to `learn.chatgpt.com/docs/*`.

### 1. `codex app-server`

- **Launch:** `codex app-server` uses stdio by default. Flags: `--listen <URL>`, which takes `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT` or `off`. `--stdio` is an alias for `--listen stdio://`. Other flags: `--strict-config`, `--analytics-default-enabled` (analytics are off by default for app-server), and WebSocket auth flags `--ws-auth capability-token|signed-bearer-token`, `--ws-token-file`, `--ws-token-sha256`, `--ws-shared-secret-file`. Subcommands: `daemon`, `proxy`, `generate-ts`, `generate-json-schema` (the last two are experimental and produce protocol bindings). Source: codex-rs/cli/src/main.rs `AppServerCommand` (github.com/openai/codex, checked 2026-10-03); https://learn.chatgpt.com/docs/app-server (checked 2026-10-03)
- **Status:** the docs say: "The app-server command and WebSocket transport are experimental and aren't supported for production workloads." Source: https://learn.chatgpt.com/docs/app-server (checked 2026-10-03)
- **Wire format:** "JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"` header omitted on the wire)". On stdio, messages are newline-delimited JSON (JSONL). On WebSocket, each text frame carries one message. Code comment: "We do not do true JSON-RPC 2.0, as we neither send nor expect the "jsonrpc": "2.0" field." Source: https://learn.chatgpt.com/docs/app-server ; codex-rs/app-server-protocol/src/rpc.rs (checked 2026-10-03)
- **Handshake:** the client sends `{"method":"initialize","id":0,"params":{"clientInfo":{"name":"my_client","title":"My Client","version":"0.1.0"},"capabilities":{...}}}`, then the notification `{"method":"initialized","params":{}}`. No other method is allowed before `initialize`. Optional `capabilities` fields: `experimentalApi` (bool; experimental methods and fields are rejected without it), `optOutNotificationMethods` (string[]), `requestAttestation`, `explicitGatewayOauth`, `extensions`, `mcpServerOpenaiFormElicitation`. The response includes `userAgent`. Docs: "Use `clientInfo.name` to identify your client for the OpenAI Compliance Logs Platform. If you are developing a new Codex integration intended for enterprise use, please contact OpenAI to get it added to a known clients list." Source: codex-rs/app-server-protocol/src/protocol/v1.rs `InitializeParams/ClientInfo/InitializeCapabilities`; https://learn.chatgpt.com/docs/app-server (checked 2026-10-03)
- **Core client→server methods (exact names):** `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/archive`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`, `review/start`, `command/exec`. Source: codex-rs/app-server-protocol/src/protocol/common.rs (checked 2026-10-03)
  - `thread/start` params (camelCase): `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox` (SandboxMode), `permissions`, `config`, `baseInstructions`, `developerInstructions`, `personality`, `ephemeral`, and others. The response carries `result.thread.id`.
  - `thread/resume` params: `threadId` (required), plus optional `history`, `path`, `model` and `modelProvider`.
  - `turn/start` params: `threadId` and `input: UserInput[]`, where UserInput is tagged by `type`: `text {text}`, `image`, `localImage {path}`, `audio`, `localAudio`, and others. Optional per-turn overrides: `cwd`, `approvalPolicy`, `sandboxPolicy`, `model`, `effort`.
  - `turn/interrupt` params: `{threadId, turnId}`.
  - Source: codex-rs/app-server-protocol/src/protocol/v2/thread.rs, v2/turn.rs (checked 2026-10-03)
- **Server→client requests (approvals):** the server sends `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. Related requests: `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call` (dynamic tools, experimental), `account/chatgptAuthTokens/refresh`. Source: common.rs `server_request_definitions!` (checked 2026-10-03)
  - Response shape for both approval requests: `{"decision": <Decision>}`.
  - Command decisions: `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`, `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[...]}}`, or `{"applyNetworkPolicyAmendment":{...}}`. `decline` lets the turn continue. `cancel` also interrupts the turn.
  - File-change decisions: `accept`, `acceptForSession`, `decline`, `cancel`.
  - Command request params: `threadId`, `turnId`, `itemId`, `startedAtMs`, `reason?`, `command?`, `cwd?`, `commandActions?`, `proposedExecpolicyAmendment?`, `networkApprovalContext?`, `availableDecisions?`. File request params: `threadId`, `turnId`, `itemId`, `startedAtMs`, `reason?`, `grantRoot?`.
  - After the client answers, the server emits `serverRequest/resolved`, then `item/completed` with status `completed|failed|declined`.
  - Source: codex-rs/app-server-protocol/src/protocol/v2/item.rs; https://learn.chatgpt.com/docs/app-server#approvals (checked 2026-10-03)
- **Notifications (exact names):** `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed` (check `turn.status`: only `completed` means success; `failed` and `interrupted` do not), `turn/diff/updated`, `turn/plan/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `thread/tokenUsage/updated`, `error`, `warning`, `account/updated`, `account/login/completed`, `account/rateLimits/updated`. Source: common.rs `server_notification_definitions!`; https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server (checked 2026-10-03)
- **Sandbox modes** (`thread/start.sandbox`, kebab-case): `read-only`, `workspace-write`, `danger-full-access`. **Per-turn `sandboxPolicy`** is a tagged object: `{type:"readOnly", networkAccess}`, `{type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}`, `{type:"dangerFullAccess"}`, or `{type:"externalSandbox", networkAccess}`. Source: v2/shared.rs `SandboxMode`; v2/permissions.rs `SandboxPolicy` (checked 2026-10-03)
- **Approval policy** (`approvalPolicy`): `untrusted`, `on-request`, `never`, plus an experimental `{granular:{sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}}`. `on-failure` is not in the v2 enum. Source: v2/shared.rs `AskForApproval` (checked 2026-10-03)
- **Auth methods:** `account/read` returns `{account, requiresOpenaiAuth}`. `account/login/start` takes `{type:"apiKey", apiKey}`, `{type:"chatgpt"}` (browser OAuth), `{type:"chatgptDeviceCode"}`, or the experimental `{type:"chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType?}`. The code labels `chatgptAuthTokens` "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE"; the docs describe it as for host apps that own the ChatGPT auth lifecycle. Other auth methods: `account/login/cancel`, `account/logout`, `account/rateLimits/read`, `account/usage/read`. The `account/updated.authMode` values are `apikey`, `chatgpt`, `chatgptAuthTokens`, `agentIdentity`, `personalAccessToken`, `bedrockApiKey`, or null. Source: v2/account.rs `LoginAccountParams`; https://learn.chatgpt.com/docs/app-server#auth-endpoints (checked 2026-10-03)
- **Related change:** `codex mcp-server` (Codex hosted as an MCP server) has been removed. Integrations should use app-server instead. Source: https://learn.chatgpt.com/docs/mcp-server (checked 2026-10-03)

### 2. Sign in with ChatGPT and third-party apps running codex app-server

- The app-server docs say, verbatim: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT so users have greater control over and visibility into their usage. ... **App-server authentication has never been permitted for commercial or hosted services.** We launched Sign in with ChatGPT to support these use cases ... Join our partner waitlist here." Source: https://learn.chatgpt.com/docs/app-server#auth-endpoints (checked 2026-10-03)
- **Officially supported path for local/OSS apps: SIWC "ChatGPT plan usage".** "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." The flow uses dynamic registration: authorize at `https://auth.openai.com/api/accounts/authorize` with `client_id=dynamic_agent_client`, `agent_name_hint=<app name>`, `ext_agent_host_id` (`urn:uuid:…` or a JWK-thumbprint URN), PKCE S256, a loopback redirect `http://127.0.0.1:<port>/auth/callback`, scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, and `resource=https://api.openai.com/v1`. The docs state: "This direct flow needs neither a client secret nor a partner API key." Source: https://developers.openai.com/siwc/token-sharing-open-source ; https://developers.openai.com/siwc/token-sharing-open-source/sign-in (checked 2026-10-03)
- **App-server setup with a SIWC token:** set `ACCESS_TOKEN` in the child process environment, then launch with `codex app-server --listen stdio:// -c 'model_provider="openai_chatgpt_plan"' -c 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"' -c 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"' -c 'model_providers.openai_chatgpt_plan.wire_api="responses"' -c 'model_providers.openai_chatgpt_plan.requires_openai_auth=false' -c 'model_providers.openai_chatgpt_plan.supports_websockets=false'`. "No separate Codex sign-in is required." `clientInfo.name` "should match the agent_name_hint". The app must refresh the token itself, restart app-server, then call `thread/resume`. Source: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server (checked 2026-10-03)
- **Preview limitations:** `store:false` and `stream:true` are forced. Hosted tools (image generation, file search, Code Interpreter, hosted MCP/connectors, tool_search) are not supported, and neither is audio input. Source: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations (checked 2026-10-03)
- **Commercial access:** "Sign in with ChatGPT is currently offered to a select group of commercial partners. To join the waitlist, complete the Sign in with ChatGPT interest form" (https://openai.com/form/sign-in-with-chatgpt-interest/). Source: https://developers.openai.com/siwc/request-client-id (checked 2026-10-03)
- **User eligibility:** "eligible ChatGPT Plus and Pro subscribers can also choose to use their ChatGPT plan". Usage counts against plan limits, and users can cap each app in Settings > Usage. Source: https://learn.chatgpt.com/docs/sign-in-with-chatgpt (checked 2026-10-03)
- **UI requirements:** the button must read "Continue with ChatGPT" and use the approved branding. Show "Using ChatGPT plan" near the composer with a "Manage usage" link to chatgpt.com/settings/usage. The pricing page must say which of the app's plans support ChatGPT plan usage. Source: https://developers.openai.com/siwc/ui-ux-guidelines (checked 2026-10-03)
- **Conclusion for Chalito:**
  - Free/OSS and local: allowed, using SIWC dynamic registration with no approval. Reusing Codex's own `account/login/start type:"chatgpt"` is tolerated ("can continue") but not recommended.
  - Paid/commercial: requires the partner waitlist or approval. Do not ship a paid product on Codex's built-in ChatGPT login.

### 3. OpenAI Realtime

- **`gpt-realtime-2.1-mini` exists.** It was released in July 2026, alongside `gpt-realtime-2.1`. Its model page lists Model ID `gpt-realtime-2.1-mini`, default snapshot `gpt-realtime-2.1-mini`, and a 128k context. It is supported only on `v1/realtime` (not on `v1/live/sessions` or Responses). Source: https://developers.openai.com/api/docs/changelog (July 2026); https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (checked 2026-10-03)
- **Current realtime and voice models:** `gpt-live-1` (the new "GPT-Live" premier voice model, which uses the `/v1/live/sessions` API), `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-translate`, `gpt-live-transcribe`, `gpt-realtime-whisper`.
  - Deprecated: `gpt-realtime` and `gpt-realtime-mini` (shutdown Jan 20, 2027, replaced by 2.1 / 2.1-mini), and the `gpt-4o-*realtime*` models.
  - `gpt-realtime-mini-2025-10-06` shut down on July 23, 2026.
  - Source: https://developers.openai.com/api/docs/models/all ; https://developers.openai.com/api/docs/deprecations (checked 2026-10-03)
- **Ephemeral credentials:** `POST https://api.openai.com/v1/realtime/client_secrets`, authenticated with a standard API key.
  - Body: `{expires_after?:{anchor:"created_at", seconds:10..7200}, session:{type:"realtime", model, audio:{output:{voice}}, ...}}`. Default TTL is 600 s (10 min); maximum is 7200 s.
  - Returns `{value:"ek_...", expires_at:<unix>, session:{...}}`.
  - Set the `OpenAI-Safety-Identifier` header when minting; it is bound to the token.
  - Source: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create ; https://developers.openai.com/api/docs/guides/voice-webrtc (checked 2026-10-03)
- **WebRTC SDP:** `POST https://api.openai.com/v1/realtime/calls`. Two ways to call it:
  - With the ephemeral key: body is raw SDP, `Content-Type: application/sdp`, and the response body is the answer SDP.
  - "Unified interface": the server posts multipart form fields `sdp` and `session` with the standard key.
  - The data channel label is `oai-events`.
  - Source: https://developers.openai.com/api/docs/guides/voice-webrtc (checked 2026-10-03)
- **WebRTC through our server (the desktop's path; R-H6 follow-up):** the api uses the unified interface, so the desktop never holds an OpenAI credential.
  - Call: `POST /v1/realtime/calls`, `multipart/form-data` with `sdp` (the browser's offer) and `session` (JSON, same shape as the `client_secrets` session), plus `Authorization: Bearer <server key>`. `OpenAI-Safety-Identifier` is optional. The response body is the answer SDP (`application/sdp`).
  - Call id: the `Location` response header, `/v1/realtime/calls/rtc_…`. The api parses it and stores it in `voice_sessions.call_id`.
  - Hang up: `POST /v1/realtime/calls/{call_id}/hangup` ends a WebRTC call as well as a SIP one. It returns 200; a repeat on an already-ended call returns 404, which we treat as done. The api calls it at the monthly cap, the session maximum, end, revoke and the stale sweep.
  - Sideband control: `wss://api.openai.com/v1/realtime?call_id=rtc_…` with the server key (not used yet).
  - Max duration: I found no per-call duration limit on `/v1/realtime/calls` or in the session config (only the platform's own session limit). Our limit is the api's clock (`maxSeconds`) plus the hang-up.
  - Sources: https://developers.openai.com/api/docs/guides/realtime-webrtc ; https://developers.openai.com/api/docs/guides/realtime-server-controls ; https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup (checked 2026-10-03)
- **SIP (Realtime):**
  - Point the SIP trunk (e.g. Twilio Elastic SIP) at `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`, where the project ID starts with `proj_`. For EU residency, use `sip-eu.api.openai.com`.
  - Configure a project webhook (platform settings > Project > Webhooks). It fires `realtime.call.incoming` with `data.call_id` and `data.sip_headers`. Verify the `webhook-signature`.
  - Call controls:
    - Accept: `POST /v1/realtime/calls/{call_id}/accept`, body `{type:"realtime", model, instructions, ...}`, returns 200.
    - Reject: `POST /v1/realtime/calls/{call_id}/reject`, body `{status_code:486}`; the default is 603.
    - Transfer: `/refer` with `{target_uri}`.
    - Hang up: `/hangup`.
  - Monitor the call over a WebSocket using `call_id`.
  - Source: https://developers.openai.com/api/docs/guides/voice-sip (checked 2026-10-03)
- **SIP (GPT-Live variant):** the webhook event is `live.transport.incoming` (`data.type:"sip"`, `data.session_id`); `live.call.incoming` is deprecated. Controls are `POST /v1/live/sessions/{session_id}/accept|reject|refer|hangup`. Outbound calls are also supported. Source: https://developers.openai.com/api/docs/guides/voice-sip (checked 2026-10-03)
- **Pricing (per 1M tokens):**

  | Model | Audio in | Audio cached | Audio out | Text in / cached / out |
  | --- | --- | --- | --- | --- |
  | `gpt-realtime-2.1-mini` | $10.00 | $0.30 | $20.00 | $0.60 / $0.06 / $2.40 |
  | `gpt-realtime-2.1` | $32.00 | $0.40 | $64.00 | $4 / $0.40 / $24 |

  - `gpt-live-1` is billed per second at $0.05/min, plus separate backend model costs. WebRTC session creation bills 15 s up front, which is credited back.
  - Audio tokens: user audio = 1 token per 100 ms, assistant audio = 1 token per 50 ms. Derived estimate for 2.1-mini: about $0.006/min of user audio and about $0.024/min of model audio, before context re-billing (derived, not quoted).
  - Source: https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/guides/voice-latency-cost (checked 2026-10-03)

### 4. ChatGPT Developer mode and remote MCP apps

- **Eligibility:** "Available to Pro, Plus, Business, Enterprise, and Education accounts on the web." Turn it on in Settings → Security and login → Developer mode. "availability can depend on account and workspace policy" (admins on Business/Enterprise). Source: https://developers.openai.com/api/docs/guides/developer-mode ; https://developers.openai.com/plugins/deploy/connect-chatgpt (checked 2026-10-03)
- **Write actions:** "full Model Context Protocol (MCP) client support for all tools, both read and write". Developer mode does not require `search`/`fetch` tools. Write tools are subject to confirmation settings. Source: https://developers.openai.com/api/docs/guides/developer-mode (checked 2026-10-03)
- **Transport and auth:** SSE and streaming HTTP are supported. Auth can be OAuth, No Authentication, or Mixed (initialize and tools/list without auth; per-tool security schemes). Source: https://developers.openai.com/api/docs/guides/developer-mode (checked 2026-10-03)
- **OAuth requirements:**
  - DCR is not required. ChatGPT prefers CIMD (Client ID Metadata Documents, `client_id=https://chatgpt.com/oauth/client.json`) when the authorization server sets `client_id_metadata_document_supported:true`. DCR via `registration_endpoint` and static/predefined clients are also supported.
  - Required: `/.well-known/oauth-protected-resource` (RFC 9728) or `WWW-Authenticate: Bearer resource_metadata=...` on 401, AS metadata at `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`, and PKCE `S256` listed in `code_challenge_methods_supported`.
  - Source: https://developers.openai.com/plugins/build/auth (checked 2026-10-03)
- **Apps SDK status:** "Apps" are now branded **Plugins** ("ChatGPT plugins and Apps SDK"). Plugins combine MCP servers, skills and optional UI that implements the open MCP Apps UI standard. Developer-mode apps are created at chatgpt.com/plugins. Public directory submission works through platform.openai.com/plugins and needs individual or business verification. The MCP server is rescanned daily after publication. Source: https://developers.openai.com/plugins/build/app-quickstart ; https://developers.openai.com/plugins/deploy/submission (checked 2026-10-03)

### 5. xAI

- **API:** OpenAI-compatible base URL `https://api.x.ai/v1` (Responses and Chat Completions). Auth uses `XAI_API_KEY` (`xai-...`). The company is now styled "SpaceXAI". Source: https://docs.x.ai/developers/quickstart ; https://docs.x.ai/llms.txt (checked 2026-10-03)
- **Current model ids and pricing (per 1M tokens, input / cached input / output, for prompts under 200k tokens):**

  | Model | Context | Input | Cached input | Output |
  | --- | --- | --- | --- | --- |
  | `grok-4.7` (recommended) | 500k | $2.00 | $0.50 | $6.00 |
  | `grok-4.6` | 500k | $2.00 | $0.50 | $6.00 |
  | `grok-4.5` | 500k | $2.00 | $0.30 | $6.00 |
  | `grok-4.3` | 1M | $1.25 | $0.20 | $2.50 |
  | `grok-4.20-0309-reasoning` / `-non-reasoning` | 1M | $1.25 | $0.20 | $2.50 |
  | `grok-build-0.1` | 256k | $1.00 | $0.20 | $2.00 |
  | `grok-4.20-multi-agent-0309` | 1M | $1.25 | $0.20 | $2.50 |

  - Prompts of 200k tokens or more are billed at roughly 2x these rates.
  - Voice: `grok-voice-think-fast-2.0` speech-to-speech costs $0.08/min.
  - The US regional endpoint applies a 1.1x multiplier.
  - Source: https://docs.x.ai/developers/models ; https://docs.x.ai/developers/pricing (checked 2026-10-03)
- **Grok Build exists** (beta). It is xAI's coding agent CLI `grok`, installed with `curl -fsSL https://x.ai/cli/install.sh | bash` or `npm i -g @xai-official/grok` (npm latest 1.0.46). Modes: TUI, headless (`grok -p "..." --output-format streaming-json`), and **ACP: `grok agent stdio`**, which "runs Grok as an ACP agent over JSON-RPC on stdin/stdout" with `initialize` (protocolVersion 1), `authenticate`, `session/new`, `session/prompt`, and `session/update` chunks (`agent_message_chunk`). Pass `--no-auto-update` in automation. Source: https://docs.x.ai/build/overview ; https://docs.x.ai/build/cli/headless-scripting ; https://docs.x.ai/build/cli/reference (checked 2026-10-03)
- **Grok Build auth:**
  - Four methods: browser OIDC (`grok login`), device code (`grok login --device-auth`), an external `auth_provider_command`, and API key (`XAI_API_KEY` or `model.api_key`).
  - ACP `authMethods` ids include `xai.api_key` and `cached_token` (a prior `grok login`).
  - Credential precedence: `model.api_key` > `model.env_key` > session token > `XAI_API_KEY`.
  - Source: https://docs.x.ai/build/enterprise ; https://docs.x.ai/build/cli/headless-scripting (checked 2026-10-03)
- **Subscriptions vs API:**
  - Raw API: "the account is shared between Grok and xAI API ... However, the billing is separate for Grok and xAI API" (API billing is via console.x.ai prepaid credits). So there is no official way to call `api.x.ai` with a SuperGrok/X Premium subscription; it needs an API key.
  - Caveat: Grok Build's login session (and therefore ACP `cached_token`) draws on the user's Grok plan. Paid plans share one weekly usage pool across "API, Build, Chat, Imagine, Voice", and Grok 4.7 Fast is "billed through your plan" in Grok Build. Grok Build also has a free tier.
  - Driving `grok agent stdio` under the user's own login therefore appears to be an official way to use a subscription programmatically through Grok Build. There is no public statement on third-party embedding terms (UNVERIFIED).
  - Source: https://docs.x.ai/console/faq/accounts (in https://docs.x.ai/llms-full.txt); https://docs.x.ai/grok/faq ; https://docs.x.ai/developers/pricing (checked 2026-10-03)

### 6. OpenAI prompt caching and cheap-model prices

- **Caching is automatic** (implicit mode, on by default), with "discounted up to 95%".
- **GPT-5.6 and later:**
  - Minimum cacheable prefix is 1,024 tokens.
  - **Cache writes cost 1.25×** the uncached input rate. Reads cost 0.1× (0.05× on gpt-6.1-sol).
  - Optional explicit mode: `prompt_cache_options.mode:"explicit"` with `prompt_cache_breakpoint`, up to 4 writes per request.
  - `prompt_cache_options.ttl` accepts only `"30m"`.
  - `prompt_cache_key` is optional (used only for accounting).
- **Before GPT-5.6:** no write charge. `prompt_cache_retention` is `in_memory` or `24h`, and a stable `prompt_cache_key` helps routing.
- Source: https://developers.openai.com/api/docs/guides/prompt-caching (checked 2026-10-03)
- **Prices for prices.yaml** (Standard tier, per 1M tokens, input / cached input / cache write / output):

  | Model | Input | Cached input | Cache write | Output |
  | --- | --- | --- | --- | --- |
  | `gpt-6-luna` (cheapest current frontier) | $0.10 | $0.01 | $0.125 | $0.50 |
  | `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | $1.20 |
  | `gpt-5-mini` | $0.25 | $0.025 | none | $2.00 |
  | `gpt-5-nano` | $0.05 | $0.005 | none | $0.40 |
  | `gpt-5.4-mini` | $0.75 | $0.075 | none | $4.50 |

  - Long-context rates for the gpt-6 and 5.6 models are 2x input.
  - Batch and Flex tiers are about 50% of standard.
  - Source: https://developers.openai.com/api/docs/pricing (checked 2026-10-03)

### 7. OpenAI brand guidelines and product naming

- Plugin guidelines: "Plugins should not imply that they are made or endorsed by OpenAI." Do not append "MCP"/"Plugin" to names, and avoid generic names. Source: https://developers.openai.com/plugins/plugin-guidelines (checked 2026-10-03)
- SIWC: the button must be "Continue with ChatGPT" in the approved formats. Source: https://developers.openai.com/siwc/ui-ux-guidelines ; https://developers.openai.com/siwc/website (checked 2026-10-03)
- openai.com/brand returned HTTP 403 to automated fetch, so these points come from search snippets only (UNVERIFIED verbatim):
  - "GPT" may not be used in app, product or company names.
  - Third parties may not use OpenAI names, logos or marks without written consent, or imply partnership or endorsement.
  - Referential use ("powered by GPT-…", "works with ChatGPT") must be accurate.
  - Source: https://openai.com/brand/ (403, checked 2026-10-03)
- **Implication:** "Chalito" contains neither "ChatGPT" nor "GPT", which is fine. Avoid names like "ChatGPT for X" or "XGPT". Use descriptive referential phrasing, for example "Works with ChatGPT/Codex".

### 8. Brain APIs for the Mesa: forced function calls and usage (checked 2026-10-03)

The orchestrator makes every brain answer through ONE forced function, `respond`. The shapes below were verified for that contract and for pricing usage correctly.

- **OpenAI Responses API** (`openai` npm 7.27.0, `POST https://api.openai.com/v1/responses`):
  - Tool: `{type: "function", name, description, parameters (JSON Schema), strict}`.
  - Force one function: `tool_choice: {type: "function", name}`.
  - Output item: `{type: "function_call", id, call_id, name, arguments}`, where `arguments` is a **JSON string**.
  - System prompt: `instructions`. Also `max_output_tokens`, `store`, and `prompt_cache_key` (cache routing).
  - Usage: `input_tokens`, `input_tokens_details.{cached_tokens, cache_write_tokens}`, `output_tokens` (includes `output_tokens_details.reasoning_tokens`).
  - **`cached_tokens` and `cache_write_tokens` are parts of `input_tokens`.** The docs' cost example is `ordinary = input_tokens − cached_tokens − cache_write_tokens`.
  - Source: https://developers.openai.com/api/docs/guides/function-calling ; https://developers.openai.com/api/docs/guides/prompt-caching ; SDK typings `resources/responses/responses.d.ts` (`ResponseUsage.InputTokensDetails`).
- **xAI Responses API** (`POST https://api.x.ai/v1/responses`, OpenAI-compatible, used with the `openai` SDK and `baseURL`):
  - Tool: `{type: "function", name, parameters}`.
  - Force one function: `tool_choice: {type: "function", name}`. The guide also shows the Chat Completions form `{type: "function", function: {name}}`; the Responses reference uses the flat form.
  - Output: `{type: "function_call", name, arguments: string, call_id}`.
  - Usage: `input_tokens`, `input_tokens_details.cached_tokens` (**a subset of `input_tokens`**), `output_tokens`, `cost_in_usd_ticks`.
  - No cache-write charge is documented.
  - Source: https://docs.x.ai/developers/rest-api-reference/inference/responses ; https://docs.x.ai/docs/guides/function-calling ; https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing
- **Gemini via `@google/genai`** (2.27.0):
  - Call: `ai.models.generateContent({model, contents, config: {systemInstruction, maxOutputTokens, tools: [{functionDeclarations: [{name, description, parametersJsonSchema}]}], toolConfig: {functionCallingConfig: {mode: "ANY", allowedFunctionNames: [name]}}}})`.
  - The call comes back in `response.functionCalls[i].args`, an object.
  - Usage: `usageMetadata.{promptTokenCount, cachedContentTokenCount, candidatesTokenCount, thoughtsTokenCount}`. **`promptTokenCount` includes the cached tokens** ("still the total effective prompt size … includes the number of tokens in the cached content"). Thinking tokens are billed at the output rate.
  - Endpoints:
    - Vertex with `{vertexai: true, project, location: "global"}` (D-012; Cloud Run ADC). In express mode (`{vertexai: true, apiKey}`), `@google/genai` calls `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/<model>:generateContent`.
    - A Gemini API key (BYO) calls `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`.
  - The ai.google.dev guide now leads with an "interactions" API (`client.interactions.create`, `tool_choice: "any"`). We use the stable `models.generateContent` surface, which is also Vertex's.
  - Source: https://ai.google.dev/gemini-api/docs/function-calling ; https://ai.google.dev/api/generate-content ; SDK typings `dist/genai.d.ts` (`FunctionCallingConfig`, `FunctionCallingConfigMode`, `GenerateContentResponseUsageMetadata`); request URLs observed with msw.
- **Chalyb hub, trial state** (read-only, chalyb `a5733df`): `GET /api/engines/{slug}/usage/balance` returns `{ok, balance: TokenBalance}` = `{remaining, unlimited, monthlyAllocation, bonus, monthlyUsed, reserved, periodStart}`. Admit returns the same balance. **Neither exposes a trial flag**, so Chalito keeps `hubTrialActive: false` (D-026 is still open on the hub side).

### Deviations from the prompt

- Docs moved: `developers.openai.com/codex/app-server` now redirects to `learn.chatgpt.com/docs/app-server`.
- The wire format is not strict JSON-RPC 2.0: the `"jsonrpc":"2.0"` field is omitted. On stdio it is JSONL.
- `--listen stdio://` exists but is the default. `--stdio` is an alias.
- The approval policy has no `on-failure` value. There is an experimental `granular` object.
- `thread/start` takes a `sandbox` string (`read-only|workspace-write|danger-full-access`), but `turn/start` takes `sandboxPolicy` as a tagged camelCase object.
- Approval responses are `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}`, not approve/deny.
- The login method is `account/login/start` (not `account/login`), with types `apiKey`, `chatgpt`, `chatgptDeviceCode`, and `chatgptAuthTokens` (internal/experimental).
- App-server is labeled experimental and "not supported for production workloads". `codex mcp-server` has been removed.
- Using Codex's built-in ChatGPT login is "never permitted for commercial or hosted services". The sanctioned route is SIWC ChatGPT-plan usage: free for OSS/local apps via `dynamic_agent_client`, waitlist for paid or hosted apps. Only Plus and Pro users are eligible to spend their plan.
- OpenAI now pushes GPT-Live (`gpt-live-1`, `/v1/live/sessions`, $0.05/min) as the primary voice path. The Realtime API (`/v1/realtime/*`) still exists. GPT-Live SIP uses `live.transport.incoming` instead of `realtime.call.incoming`.
- ChatGPT "apps/connectors" are now "Plugins". The developer-mode toggle lives under Settings → Security and login. ChatGPT prefers CIMD over DCR, and DCR is not required.
- The cheapest current OpenAI model is `gpt-6-luna`, not gpt-5-mini (though gpt-5-mini is still listed). GPT-5.6+ caching adds a 1.25× cache-write charge, so savings are not purely discounts.
- xAI: Grok Build exists and supports ACP (`grok agent stdio`). Grok login sessions draw on the Grok subscription's usage pool, so "subscription → API key only" holds for the raw REST API but not for Grok Build.

### Unverifiable / open

- Exact openai.com/brand wording (403). Verify manually in a browser.
- Whether "Chalito" counts as "commercial" under SIWC (for example, a paid desktop app running locally). The docs separate "open-source and locally hosted" (self-serve) from "paid or remotely hosted" (interest form). A paid local app is ambiguous, so contact OpenAI (UNVERIFIED).
- Whether non-OSS closed-source free local apps qualify for the `dynamic_agent_client` flow (docs say "open-source and locally hosted apps") (UNVERIFIED).
- xAI terms for third-party apps embedding `grok agent stdio` under a user's subscription login. No explicit permission or prohibition was found (UNVERIFIED).
- The help.openai.com developer-mode article returned 403. Plan eligibility was taken from the developers.openai.com guide instead.
- Realtime per-minute cost figures are derived from token rates, not quoted.
- Grok Build availability by plan (free tier limits, which SuperGrok tiers) was not detailed in the docs fetched (UNVERIFIED).


---

## Comms: WhatsApp Cloud API, Twilio, Verify, SMS, Web Push

This was read-only research. Nothing was signed up for, bought or sent. Prices are list prices in USD unless noted.

---

### 1. WhatsApp Cloud API (direct, no BSP)

#### Graph API version
- The latest Graph API version is **v26.0**, released 2026-07-29, with no expiry date set yet. v25.0 was released 2026-02-18 and expires 2028-07-29. v24.0 expires 2028-02-18. v23.0 expires 2027-10-08. Recommendation: pin `v26.0`, or `v25.0` if you prefer something more settled.
  Source: https://developers.facebook.com/docs/graph-api/changelog/versions/ (checked 2026-10-03)
- The WhatsApp template docs still show `v23.0` in their examples. That version still works but is not current.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview (checked 2026-10-03)

#### Send a template message
- Endpoint: `POST https://graph.facebook.com/{Version}/{Phone-Number-ID}/messages`, authenticated with a Bearer system-user token.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api (checked 2026-10-03)
- Payload shape (positional params):
  ```json
  {
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "+5215512345678",
    "type": "template",
    "template": {
      "name": "chalito_alert",
      "language": { "code": "es_MX" },
      "components": [
        { "type": "body", "parameters": [
            { "type": "text", "text": "3" },
            { "type": "text", "text": "urgente" } ] },
        { "type": "button", "sub_type": "url", "index": "0",
          "parameters": [ { "type": "text", "text": "a/9rwnB8RbYm" } ] }
      ]
    }
  }
  ```
  For URL buttons, `parameters[0].text` is a suffix that gets appended to the URL prefix defined in the template. `index` is the button's position, as a string.
  Source: same as above; https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/ (checked 2026-10-03)
- **Named parameters** are supported: `{{first_name}}`, using lowercase letters and underscores. The send payload then adds `"parameter_name"` to each parameter. **Positional** parameters `{{1}}`, `{{2}}` must be sent in order.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview (checked 2026-10-03)
- Component limits:
  - Body: required, at most 1024 characters.
  - Header text: at most 60 characters, 1 parameter.
  - Footer: at most 60 characters.
  - Buttons: at most 10 in total, at most 2 URL buttons.
  - A URL button supports **one variable, appended to the end of the URL**. URLs can be up to 2000 characters, and a variable needs an example value at template creation.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components (checked 2026-10-03)

#### Template categories
- **Utility** templates must meet both of these:
  - (a) "non-promotional, not containing any promotional or persuasive intent"
  - (b) "specific to or requested by the user (clearly related to their order, account, services, or transactions) OR essential or critical to the user"

  "Account Alerts or Updates" is an explicitly allowed utility use case.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization (checked 2026-10-03)
- Templates whose content is unclear are classified as **marketing**. Meta's examples are templates whose content is only `{{1}}`, or just "Congratulations!". Mixed utility and promo content also counts as marketing. Meta can automatically recategorize a template with 1 day's notice, or with no notice after a misuse warning. You can appeal a REJECTED category within 60 days.
  Source: same (checked 2026-10-03)
- **Authentication** is the only category allowed to send OTPs. URLs, media and emojis are not allowed, and parameters are limited to 15 characters.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates (checked 2026-10-03)
- Can a utility template carry only counts and urgency plus a deep-link button? **Likely yes, if the fixed text gives context.** Example: "Tienes {{count}} pendientes en tu cuenta de Chalito, prioridad {{urgency}}. Revisa los detalles." with a URL button `https://app.chalito…/a/{{1}}`. A body made mostly of variables risks the "unclear contents → marketing" rule. The final category is Meta's call at review: **UNVERIFIED until a template is submitted**.

#### Webhooks
- Verification is a GET request with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`. Check that the token matches the Verify Token you set in the App Dashboard, then return `hub.challenge` in a 200 response.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started ; https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks (checked 2026-10-03)
- Signature: the `X-Hub-Signature-256: sha256=<hex>` header carries an HMAC-SHA256 of the **raw request body**, keyed with the **app secret**. Compare it to the value after `sha256=`.
  Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks (Meta Webhooks; same mechanism) (checked 2026-10-03)
- Payloads can be up to 3 MB. Meta retries for up to 7 days, so expect duplicates and make handlers idempotent. mTLS is supported.
  Source: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks (checked 2026-10-03)
- Message statuses (sent, delivered, read, failed) arrive on the `messages` webhook field. Marketing opt-outs arrive on the **`user_preferences`** webhook field. Error 131050 means a message was not delivered because of the user's marketing preference. Error 131049 means the per-user marketing limit was hit. For utility traffic there is no platform STOP keyword, so handle opt-out yourself (for example with a quick-reply "Dejar de recibir") **(UNVERIFIED: no official doc found for a utility-specific opt-out signal)**.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog ; https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes (checked 2026-10-03)

#### Pricing (per-message)
- Billing has been per message since 2025-07-01. A template is charged when it is **delivered**, and the price depends on the recipient's country code and the template category. Volume tiers apply to utility and authentication and reset monthly.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing (checked 2026-10-03)
- **Change effective 2026-10-01:**
  - Utility messages sent inside an open 24-hour customer service window are now **charged per message**. They had been free since 2025-07-01.
  - **Service (free-form) messages are now also charged** at the market's utility/authentication rate, with no volume tiers.
  - Meta Business Agent messages cost $2.00 per 1M tokens (from 2026-08-01).
  - The 72-hour free-entry-point window is unchanged.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages (checked 2026-10-03)
- Meta also says it will stop delivering service messages from 2026-10-01 for direct integrators with no payment method on file (seen via a search snippet of Meta docs; **UNVERIFIED on the page itself**).
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing (checked 2026-10-03)
- **Official USD rate card, effective 2026-10-01** (xlsx linked from the pricing page):

  | Market | Marketing | Utility | Authentication | Service |
  |---|---|---|---|---|
  | **Mexico** | 0.0397 | **0.0085** | 0.0085 | 0.0085 |
  | North America | 0.025 | 0.0034 | 0.0034 | 0.0034 |
  | Rest of Latin America | 0.074 | 0.0113 | 0.0113 | 0.0113 |
  | Spain | 0.0707 | 0.02 | 0.02 | 0.02 |

  The MXN card lists Mexico utility at MXN 0.1565.
  Source: rate-card links on https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing (checked 2026-10-03)

#### Business verification and limits
- A new business portfolio, or an unverified business, starts with a **messaging limit of 250 unique users per rolling 24 hours** for messages outside a service window. To raise it: verify the business, or deliver 2,000 messages outside the window to unique users within 30 days using high-quality templates.
  Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits (checked 2026-10-03)
- An unverified portfolio can have at most 250 templates per WABA. A verified portfolio with an approved display name gets 6,000.
  Source: same (checked 2026-10-03)
- A display name approval is required. A test number with up to 5 recipients is available in the dev app (general Meta practice; **UNVERIFIED this session**).

---

### 2. Twilio Voice

#### `<Gather>`
- `input`:
  - Values: `dtmf` (default), `speech`, or `dtmf speech`.
- `language`:
  - Default is `en-US`. `es-MX` is listed as supported.
  - Supported languages depend on `speechModel`.
- `speechTimeout`:
  - Takes a positive integer (seconds) or `auto`. The default is the `timeout` value.
  - `auto` stops recognition at the first pause.
  - **If you set `speechModel`, the docs say to set `speechTimeout` to an integer, not `auto`.**
- `speechModel`:
  - Generic values: `default`, `numbers_and_commands`, `phone_call`, `experimental_conversations`, `experimental_utterances`. Generic models get automatic provider failover.
  - Specific values: `googlev2_long|short|telephony|telephony_short|chirp_3`, `deepgram_nova-2|nova-3`. These get no failover.
  - `phone_call` and the `experimental_*` models do **not** list es-MX. They list es-US and es-ES.
- `actionOnEmptyResult="true"`:
  - Forces the webhook to `action` even when there was no input. The default is `false`, which falls through to the next verb.
- Other attributes: `hints` takes up to 500 entries; `finishOnKey` defaults to `#`; `timeout` defaults to 5 s.

Source: https://www.twilio.com/docs/voice/twiml/gather (checked 2026-10-03)

Suggested settings: `<Gather input="dtmf speech" language="es-MX" speechTimeout="auto" actionOnEmptyResult="true" numDigits="1">`, with no `speechModel`. If you need deterministic STT, use `speechModel="googlev2_telephony"` or `deepgram_nova-3` with `speechTimeout="2"`.

#### `<Say>` voices (exact `voice=` strings)

**es-MX** (Polly only; Twilio lists no Google es-MX voices):

| Voice | Type |
|---|---|
| `Polly.Mia` | standard |
| **`Polly.Mia-Neural`** | neural |
| `Polly.Mía-Generative` | generative (accented í in the name) |
| `Polly.Andres-Neural` | neural |
| `Polly.Andres-Generative` | generative |

**es-US**:

| Voice | Type |
|---|---|
| `Polly.Lupe`, `Polly.Penelope`, `Polly.Miguel` | standard |
| `Polly.Lupe-Neural`, `Polly.Pedro-Neural` | neural |
| `Polly.Lupe-Generative`, `Polly.Pedro-Generative` | generative |
| `Google.es-US-Standard-A/B/C` | standard |
| `Google.es-US-Wavenet-A/B/C` | neural |
| `Google.es-US-Neural2-A/B/C` | neural |
| `Google.es-US-Chirp3-HD-{Aoede, Charon, Fenrir, Kore, Leda, Orus, Puck, Zephyr}` | generative |

**en-US**:
- Polly neural: `Polly.Joanna-Neural`, `Matthew-Neural`, `Danielle-Neural`, `Ruth-Neural`, `Stephen-Neural`, `Gregory-Neural`, `Kendra-Neural`, `Kimberly-Neural`, `Salli-Neural`, `Joey-Neural`.
- Polly generative: `Joanna`, `Matthew`, `Danielle`, `Ruth`, `Stephen`, `Tiffany` (each with the `-Generative` suffix).
- Google: `Google.en-US-Neural2-{A,C..J}`, `Google.en-US-Wavenet-{A..J}`, `Google.en-US-Chirp3-HD-*`.

**Other notes:**
- ElevenLabs voices are also available (Flash 2 / 2.5 models).
- Third-party voices can change without notice.
- TTS is billed per 100 characters: standard $0.0008, neural $0.0032, generative $0.0130. Basic voices are free.

Source: https://www.twilio.com/docs/voice/twiml/say/text-speech (and its `.md` version) (checked 2026-10-03)

#### `<Dial><Sip>` to an external SIP URI (OpenAI Realtime)
- `<Dial><Sip>` can reach any SIP URI. `transport` accepts `udp` (default), `tcp` or `tls`, with TLS on port 5061 by default. A `region=` parameter picks the egress region; the default is US Virginia.
  Source: https://www.twilio.com/docs/voice/twiml/sip (checked 2026-10-03)
- SRTP for outbound SIP: append `;secure=true` to the URI. The only crypto suite offered is `AES_CM_128_HMAC_SHA1_80`, and MKI is not supported.
  Source: https://www.twilio.com/docs/voice/api/secure-media (checked 2026-10-03)
- OpenAI Realtime SIP:
  - URI: `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`, or `sip-eu.api.openai.com` for EU data residency.
  - Requires **TLS on port 5061 and SRTP**. Codecs: G.711 µ-law/A-law or Opus.
  - Media IP ranges: 13.79.45.80/28, 23.98.140.64/28, 40.67.149.176/28, 40.83.204.240/28.
  - Each call fires a `realtime.call.incoming` webhook; you then accept it via the API.
  - OpenAI's docs reference Twilio **Elastic SIP Trunking**.
  Source: https://developers.openai.com/api/docs/guides/realtime-sip (checked 2026-10-03)
- Twilio has published an official tutorial (2025-09-08) that connects **Programmable Voice (Programmable SIP) to OpenAI without Elastic SIP Trunking**. It adds a Conference participant whose `to` is `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=…`. So **Elastic SIP Trunking is not required**, and `<Dial><Sip>` with the same URI uses the same SIP-out path.
  Source: https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip ; Elastic alternative: https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking (checked 2026-10-03)
- Recommended URI: `<Dial><Sip>sip:PROJ@sip.api.openai.com;transport=tls;secure=true</Sip></Dial>`. Whether `secure=true` is strictly needed is **UNVERIFIED**: Twilio's tutorial omits it, but OpenAI says SRTP is mandatory, so include it.
- The SIP interface costs $0.0040/min on top of PSTN charges.
  Source: https://www.twilio.com/en-us/voice/pricing/us (checked 2026-10-03)

#### Media Streams fallback
- `<Connect><Stream url="wss://…">` opens a **bidirectional** stream. `<Start><Stream>` is unidirectional.
- You get one bidirectional stream per call, and it blocks the TwiML that follows until the WebSocket closes.
- Only the inbound track is received. DTMF flows inbound only.
- Audio is `audio/x-mulaw`, 8000 Hz, base64, in both directions. Media Streams cost $0.0044/min.
- A bidirectional stream cannot be started through the Stream REST resource.

Source: https://www.twilio.com/docs/voice/twiml/stream ; https://www.twilio.com/docs/voice/media-streams ; https://www.twilio.com/docs/voice/media-streams/websocket-messages ; pricing https://www.twilio.com/en-us/voice/pricing/us (checked 2026-10-03)

#### Webhook signature
- `X-Twilio-Signature` is an **HMAC-SHA1** keyed with the account **auth token**, computed over the full webhook URL plus the POST parameters (sorted, with each name and value concatenated).
- JSON bodies use a `bodySHA256` query parameter and `validateRequestWithBody`.
- Twilio says to use the SDK's `validateRequest` and accept new parameters that may appear.

Source: https://www.twilio.com/docs/usage/webhooks/webhooks-security (checked 2026-10-03)

#### Geo permissions and caller ID
- International voice destinations must be enabled per country under Console → Voice → Geo Permissions. Low-risk ranges can be enabled on any account; high-risk ranges need an upgraded account. A blocked call returns error 13227.
  Source: https://www.twilio.com/docs/voice/api/dialing-permissions-resources ; https://www.twilio.com/docs/api/errors/13227 (checked 2026-10-03)
- `From` / `callerId` must be a Twilio number or a **verified Outgoing Caller ID**. Verification is done by a call that is English-only.
  Source: https://www.twilio.com/docs/voice/api/outgoing-caller-ids (checked 2026-10-03)
- Mexico:
  - Caller ID on international calls into MX is "E.164 (non-guaranteed)". Domestic MX numbers get +E.164 caller ID.
  - Dial MX mobiles as **+52 + 10 digits**, with no "1" after 52.
  - Emergency calling is not supported.
  Source: https://www.twilio.com/en-us/guidelines/mx/voice (checked 2026-10-03)
- An MX local number needs a **regulatory bundle**: ID plus proof of a local address inside the number's area (Constancia de Situación Fiscal for a business). Twilio validates the address.
  Source: https://www.twilio.com/en-us/guidelines/mx/regulatory (checked 2026-10-03)

#### Prices (list)

| Item | Price |
|---|---|
| US local number | **$1.15/mo** |
| US toll-free number | $2.15/mo |
| US outbound | $0.0140/min |
| US inbound | $0.0085/min |
| MX local number | **$6.25/mo** (voice page); the SMS page shows $6.50/mo |
| MX mobile number | $15/mo |
| MX toll-free number | $30/mo |
| Outbound to **MX mobile** | **$0.0473/min** |
| Outbound to MX landline | $0.0160/min |
| Inbound on an MX local number | $0.0100/min |
| Gather STT | $0.02 per use (Twilio-picked model); $0.025 (Deepgram / Google v2) |

Source: https://www.twilio.com/en-us/voice/pricing/us ; https://www.twilio.com/en-us/voice/pricing/mx (checked 2026-10-03)

---

### 3. Twilio Verify and Lookup
- Verify channels: SMS, Voice, WhatsApp, Email, TOTP, Push, Passkeys, Silent Network Auth, and Automatic Channel Selection. Create a verification with `POST /v2/Services/{sid}/Verifications` and `Channel=sms|call|whatsapp`.
  Source: https://www.twilio.com/docs/verify/api (checked 2026-10-03)
- Verify pricing:
  - Base fee: **$0.05 per successful verification**, plus channel fees.
  - SMS: +$0.0083 per SMS (US rate; varies by country). SMS attempts are always charged.
  - Voice: listed as "$0.05 per successful verification", with a link to Voice pricing. Voice attempts are always charged.
  - WhatsApp: +$0.0147 per authentication template (US) in the FAQ, but $0.0034 in the summary card. The page is inconsistent.
  - Failed or expired verifications do not pay the base fee.
  Source: https://www.twilio.com/en-us/verify/pricing (checked 2026-10-03)
- Lookup v2:
  - **Basic Lookup is free.** It returns E.164 and national formats plus `valid` / `validation_errors`.
  - Line Type Intelligence: $0.008 per request.
  - Caller Name: $0.01.
  - Identity Match: $0.10.
  - SMS Pumping Risk: $0.025 outside North America.
  Source: https://www.twilio.com/docs/lookup/v2-api ; https://www.twilio.com/en-us/user-authentication-identity/pricing/lookup (checked 2026-10-03)

---

### 4. SMS
- **A2P 10DLC is required** for any 10DLC (US local) number sending SMS to US recipients, including individuals and hobbyists.
  - Brand types: Sole Proprietor, Low-Volume Standard, and Standard. Standard needs a Tax ID such as an EIN or an equivalent.
  - Unregistered traffic pays extra carrier fees or gets filtered.
  Source: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc (checked 2026-10-03)
- Sending to **Mexico from a US long code** is allowed, but:
  - The sender ID is **overwritten with a short code**.
  - Delivery is best-effort.
  - Alphanumeric sender IDs must be pre-registered (Telcel, Movistar and AT&T only); an unregistered alpha sender gets overwritten.
  - Two-way SMS is supported.
  - Loan, gambling and similar content is prohibited.
  Source: https://www.twilio.com/en-us/guidelines/mx/sms (checked 2026-10-03)
- SMS to MX costs **$0.1819 per outbound segment**, and inbound costs $0.02. A failed message costs $0.001, and carrier fees may apply on top. This makes SMS the most expensive rung per touch: about 21x a WhatsApp utility message to MX.
  Source: https://www.twilio.com/en-us/sms/pricing/mx (checked 2026-10-03)
- SMS geo permissions are also set per country (same model as voice; **UNVERIFIED this session**).

---

### 5. Web Push
- **FCM web has changed. `getToken()` is now deprecated.**
  - The current docs use `register(messaging, { vapidKey })` together with `onRegistered(messaging, (installationId) => …)`, which returns a **Firebase Installation ID (FID)** to send to your server.
  - `onRegistered` fires after each `register()`, whenever the FID changes, and on `pushsubscriptionchange`.
  - Do not mix the FID APIs with the token APIs.
  - `firebase-messaging-sw.js` must exist at the domain root.
  - The page must be served over HTTPS.
  Source: https://firebase.google.com/docs/cloud-messaging/js/client (checked 2026-10-03)
- HTTP v1 send: the `token` field is deprecated in favour of `fid`, and during the transition `token` also accepts an FID. Device groups are deprecated and will be removed 2027-09-29.
  Source: https://firebase.google.com/docs/cloud-messaging/manage-tokens ; https://firebase.google.com/docs/cloud-messaging/send/v1-api (checked 2026-10-03)
- The `firebase` npm package is at **12.19.0** (modified 2026-10-01). The minimum SDK version for `register()` is **UNVERIFIED**.
  Source: `npm view firebase` (checked 2026-10-03)
- iOS/iPadOS web push:
  - Requires **16.4+** and a Home Screen web app whose manifest sets `display: standalone` or `fullscreen`.
  - The permission prompt must come from a user gesture.
  - No Apple Developer Program membership is needed.
  - Allow `*.push.apple.com` as a push endpoint.
  - The Badging API is supported.
  Source: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (checked 2026-10-03)
- 2025–2026 iOS changes:
  - **Declarative Web Push** works on iOS/iPadOS 18.4+ Home Screen apps and Safari 18.5+ on macOS. The payload has top-level `"web_push": 8030` and a `notification` object with a title and a required `navigate` URL. It needs no service worker and has no silent-push penalty, and older browsers fall back to the service worker.
  - In **iOS/iPadOS 26**, every site added to the Home Screen opens as a web app by default, and there are no installability requirements.
  Source: https://webkit.org/blog/16535/meet-declarative-web-push/ ; https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ (checked 2026-10-03)
- Android Chrome supports web push without installing the app (standard Push API through FCM; no 2026 change found).
  Source: https://firebase.google.com/docs/cloud-messaging/js/client (checked 2026-10-03)

---

### 6. Phone input: libphonenumber-js
- The latest version is **1.13.14** (dist-tag `latest`, modified 2026-09-24).
  Source: `npm view libphonenumber-js` / https://www.npmjs.com/package/libphonenumber-js (checked 2026-10-03)
- E.164 handling:
  - `parsePhoneNumber(input, defaultCountry?)` returns a PhoneNumber or undefined. Use `.number` for the E.164 string such as `+5215512345678`, `.country`, `.isValid()` and `.isPossible()`.
  - `isValidPhoneNumber(text, country?)` checks length plus digit patterns. `isPossiblePhoneNumber()` checks length only, and the author recommends it because strict validation goes stale.
  - `getType()` (MOBILE and so on) needs the `libphonenumber-js/max` metadata. The default `min` metadata is about 80 kB; `max` is about 145 kB.
  Source: https://gitlab.com/catamphetamine/libphonenumber-js/-/blob/master/README.md (checked 2026-10-03)

---

### Deviations from the prompt
1. **WhatsApp utility messages are no longer free inside the service window.** Since **2026-10-01**, utility messages sent inside the window cost money, and service (free-form) messages are now also billed, at USD 0.0085 per message for Mexico. The "free utility within customer service window" assumption is out of date.
2. **The Graph API is now at v26.0.** The WhatsApp docs examples still show v23.0.
3. **FCM `getToken()` is deprecated.** Use `register()` / `onRegistered()` with Firebase Installation IDs, and the HTTP v1 `fid` field instead of `token`.
4. **`<Dial><Sip>` to OpenAI works without Elastic SIP Trunking.** Twilio's own tutorial uses Programmable SIP. OpenAI's docs only mention Elastic SIP Trunking. OpenAI requires TLS and SRTP, so add `;transport=tls;secure=true`.
5. **There are no Google es-MX TTS voices in Twilio.** For es-MX use `Polly.Mia-Neural` or `Polly.Andres-Neural`, or Google `es-US-*` voices. The generative voice is spelled `Polly.Mía-Generative`, with an accent.
6. **Gather's `phone_call` and `experimental_*` speech models do not support es-MX.** Leave `speechModel` unset, or use a googlev2 or Deepgram model. Setting `speechModel` means `speechTimeout` must be an integer, not `auto`.
7. **SMS from a US number to MX is delivered under an overwritten short-code sender**, at $0.1819 per segment. Use SMS only as the last resort.
8. **An MX local Twilio number needs a regulatory bundle with a local address.** A US number avoids that, but caller ID into MX is "non-guaranteed".

### Unverifiable / open
- Whether Meta will approve, as **utility**, a template carrying only counts and urgency plus a deep link. This depends on review; give it non-generic fixed text and an account reference.
- Whether `secure=true` is strictly required for Twilio → OpenAI SIP, given the Twilio tutorial omits it. There are also community reports of 408 errors and per-project gating on OpenAI SIP (community.openai.com, not official).
- The exact Twilio Verify **voice** channel fee to MX (the page links to Voice pricing) and the inconsistent WhatsApp channel fee ($0.0034 vs $0.0147).
- Whether FCM-wrapped payloads can use iOS **Declarative Web Push**, since FCM controls the envelope. You may need direct VAPID Web Push to APNs-web endpoints. UNVERIFIED.
- The minimum `firebase` JS SDK version that exposes `register` / `onRegistered`.
- Whether Meta has a utility-template opt-out signal other than `user_preferences`, which is marketing-only.
- The Meta statement about stopping service-message delivery when no payment method is on file was seen only in a search snippet.


---

## Desktop: Tauri v2, packaging, keychain, three-vrm, OS services

### 1. Tauri v2 version and window API
- Current versions: `@tauri-apps/cli` 2.12.1, `@tauri-apps/api` 2.12.1 (npm, published 2026-09-30/10-01); Rust crate `tauri` 2.12.1; `tao` 0.37.1. Source: `npm view` + https://docs.rs/tauri/latest/tauri/window/struct.Window.html + https://crates.io/crates/tao (checked 2026-10-03)
- JS: `setIgnoreCursorEvents(ignore): Promise<void>`, `cursorPosition(): Promise<PhysicalPosition>`, `setAlwaysOnTop`, `setDecorations`, `setShadow`, `setSkipTaskbar`, `setFocusable`, `setVisibleOnAllWorkspaces`. Rust: `set_ignore_cursor_events`, `cursor_position` ("relative to the top-left hand corner of the desktop", can be negative), `set_always_on_top`, `set_skip_taskbar` (macOS unsupported), `set_focusable` (macOS: an already-focused window can't be unfocused by `set_focusable(false)`), `set_visible_on_all_workspaces` (Windows/iOS/Android unsupported). Source: https://v2.tauri.app/reference/javascript/api/namespacewindow/ and https://docs.rs/tauri/latest/tauri/window/struct.Window.html (checked 2026-10-03)
- Config (WindowConfig): `transparent` (Windows note: `noRedirectionBitmap` avoids white flash), `decorations`, `alwaysOnTop`, `skipTaskbar` ("hides the window icon from the taskbar on Windows and Linux"), `focus` (initially focused), `focusable`, `visibleOnAllWorkspaces` (Windows unsupported), `shadow` (Linux unsupported; on Windows `true` on undecorated window adds 1px border, so set `shadow: false` for a transparent avatar). Source: https://schema.tauri.app/config/2 and https://v2.tauri.app/reference/config/ (checked 2026-10-03)
- macOS transparency / `macOSPrivateApi`: as of Tauri 2.12.1 the `macOSPrivateApi` config is a **no-op** — "No-op in Tauri 2.12.1+ because the APIs are always enabled now"; changelog: "The `macos-private-api` feature flag / `macOSPrivateAPI` tauri.conf.json value is no longer required to use transparency or fullscreen on macOS" (PR #16166, merged 2026-09-29; wry removed the feature flags). Older docs warn private APIs can get an app rejected from the Mac App Store. Source: https://schema.tauri.app/config/2 , https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/CHANGELOG.md , https://github.com/tauri-apps/tauri/pull/16166 (checked 2026-10-03)
- Linux click-through implementation (tao): `set_ignore_cursor_events(true)` sets a GDK **input shape** of a 1x1 rect (`input_shape_combine_region`), `false` clears it. Calls `window.window().unwrap()`, so calling before the GDK window is realized can panic (matches community reports of Wayland startup crashes). Source: https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/linux/event_loop.rs (checked 2026-10-03)
- Linux `cursor_position` on **Wayland returns `(0,0)` always** (hardcoded `if is_wayland { Ok((0, 0).into()) }`); on X11 it queries the seat pointer. So cursor polling does not work on native Wayland. Workaround: force XWayland (`GDK_BACKEND=x11`), where the global pointer is readable. Source: https://github.com/tauri-apps/tao/blob/dev/src/platform_impl/linux/util.rs ; https://github.com/taengu/A2Tools-DPS-Meter/issues/14 (checked 2026-10-03)
- No per-pixel or region hit-test API is exposed by Tauri (JS or Rust). The common pattern is to poll `cursorPosition()` (~30-60 Hz, better done in Rust) against the avatar's hit-box/alpha mask and toggle `setIgnoreCursorEvents`. Alternative: hit-test in the webview on `mousemove`, but once events are ignored the webview gets no more mouse events, so you still need polling to switch back. Source: https://v2.tauri.app/reference/javascript/api/namespacewindow/ ; https://github.com/tauri-apps/tauri/issues/11461 ; https://github.com/tauri-apps/tauri/issues/9250 (checked 2026-10-03)
- Linux transparency needs a compositing WM. WebKitGTK unaccelerated/DMABUF rendering issues can cause black or blank transparent windows (`WEBKIT_DISABLE_DMABUF_RENDERER`). Source: https://v2.tauri.app/develop/debug/linux-graphics/ ; https://github.com/tauri-apps/tauri/issues/13183 (checked 2026-10-03). Compositor requirement: UNVERIFIED in official docs (general X11 knowledge).
- Wayland always-on-top: GTK `set_keep_above` has no xdg-shell equivalent, so most compositors ignore it (wlroots/GNOME). UNVERIFIED in Tauri docs. Treat Wayland as best effort and fall back to XWayland.
- Windows: transparency, always-on-top and click-through all work with WebView2 (no caveats documented beyond `noRedirectionBitmap`/shadow). Source: https://schema.tauri.app/config/2 (checked 2026-10-03)

### 2. Bundler targets
- `bundle.targets`: `"deb"`, `"rpm"`, `"appimage"`, `"nsis"`, `"msi"`, `"app"`, `"dmg"`, or `"all"` (default). Source: https://v2.tauri.app/reference/config/ (checked 2026-10-03)
- macOS universal: `tauri build --target universal-apple-darwin` (needs both rustup targets). With a sidecar, you must provide `binaries/<name>-universal-apple-darwin` as a prebuilt **universal** (lipo) binary. Mixing per-arch sidecars isn't possible (historic bug #3355). Source: https://github.com/tauri-apps/tauri/issues/3355 ; https://v2.tauri.app/develop/sidecar/ (checked 2026-10-03). The exact `-universal-apple-darwin` suffix is UNVERIFIED in the current docs page.
- tauri-action's documented matrix builds `aarch64-apple-darwin` and `x86_64-apple-darwin` separately (not universal). Source: https://github.com/tauri-apps/tauri-action (checked 2026-10-03)

### 3. Code signing
- Windows: `bundle.windows.certificateThumbprint`, `digestAlgorithm` ("sha256"), `timestampUrl` for an imported .pfx (OV). Azure Key Vault via `relic`. **Azure Artifact Signing** (formerly Trusted Signing) via `signCommand`: `"artifact-signing-cli -e https://wus2.codesigning.azure.net -a MyAccount -c MyProfile -d MyApp %1"`. `signCommand` accepts a string or `{cmd,args}` with `%1` = file path. Source: https://v2.tauri.app/distribute/sign/windows/ ; https://v2.tauri.app/reference/config/ (checked 2026-10-03)
- EV vs OV: "Microsoft removed the special treatment of EV code signing certificates from its Trusted Root Program in 2024, so EV and OV certificates now build SmartScreen reputation the same way." EV no longer bypasses SmartScreen. Source: https://v2.tauri.app/distribute/sign/windows/ (checked 2026-10-03)
- macOS env vars: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`. Notarization with an Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (= the app-specific password), `APPLE_TEAM_ID`. With the App Store Connect API: `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`. Ad-hoc signing: `signingIdentity: "-"`. Source: https://v2.tauri.app/distribute/sign/macos/ (checked 2026-10-03)
- Sidecar binaries must also be signed. Tauri signs `externalBin` during bundling: UNVERIFIED. A bun/SEA binary needs JIT entitlements (`com.apple.security.cs.allow-jit`, etc.) under the hardened runtime. Source: https://bun.com/docs/bundler/executables (checked 2026-10-03)
- Linux: AppImage GPG signing via `SIGN=1`, `SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `APPIMAGETOOL_FORCE_SIGN`. "AppImage does not validate the signature", so users must check it manually with the validate tool. Tauri docs don't cover deb/rpm signing. Source: https://v2.tauri.app/distribute/sign/linux/ (checked 2026-10-03)

### 4. Updater plugin v2
- `@tauri-apps/plugin-updater` 2.13.1. Generate keys with `tauri signer generate -w ~/.tauri/myapp.key`. Build env vars: `TAURI_SIGNING_PRIVATE_KEY` (path or content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (optional). `bundle.createUpdaterArtifacts: true` (or `"v1Compatible"` for legacy zipped updaters). Source: https://v2.tauri.app/plugin/updater/ ; https://schema.tauri.app/config/2 (checked 2026-10-03)
- `plugins.updater.pubkey` holds the key content (not a path). `endpoints` support `{{current_version}}`, `{{target}}`, `{{arch}}`. Windows `installMode`: `passive` (default) / `basicUi` / `quiet`. Capability: `updater:default`. Source: https://v2.tauri.app/plugin/updater/ (checked 2026-10-03)
- Static `latest.json`: `{ version, notes, pub_date (RFC 3339), platforms: { "linux-x86_64": { signature, url }, "darwin-aarch64": ..., "windows-x86_64": ... } }`. Dynamic endpoint: HTTP 204 = no update; 200 = `{ version, url, signature, notes?, pub_date? }`. Source: https://v2.tauri.app/plugin/updater/ (checked 2026-10-03)
- "Signature verification is mandatory and cannot be disabled": unsigned or mis-signed updates are rejected. Source: https://v2.tauri.app/plugin/updater/ (checked 2026-10-03)
- tauri-action is now `tauri-apps/tauri-action@v1`. Inputs: `tagName`, `releaseName`, `releaseDraft`, `prerelease`, `args`, `uploadUpdaterJson` (default true; generates and uploads latest.json), `updaterJsonPreferNsis`. Source: https://github.com/tauri-apps/tauri-action (checked 2026-10-03)

### 5. Sidecar
- `bundle.externalBin: ["binaries/chalito-agent"]` requires `binaries/chalito-agent-<triple>[.exe]`, e.g. `-x86_64-pc-windows-msvc.exe`, `-x86_64-apple-darwin`, `-aarch64-apple-darwin`, `-x86_64-unknown-linux-gnu`. Get the triple with `rustc --print host-tuple`. Source: https://schema.tauri.app/config/2 ; https://v2.tauri.app/develop/sidecar/ (checked 2026-10-03)
- Permissions (capabilities file): `{"identifier":"shell:allow-execute","allow":[{"name":"binaries/chalito-agent","sidecar":true}]}`, or `shell:allow-spawn` for spawning. Rust: `app.shell().sidecar("chalito-agent")?.spawn()`. JS: `Command.sidecar('binaries/chalito-agent')`. `@tauri-apps/plugin-shell` 2.4.0. Source: https://v2.tauri.app/develop/sidecar/ (checked 2026-10-03)
- The official Tauri "Node.js as a sidecar" guide uses `@yao-pkg/pkg` plus a rename script; it says any compile-to-binary tool works. Source: https://v2.tauri.app/learn/sidecar-nodejs/ (checked 2026-10-03)
- If the daemon runs as an OS service (item 10), Tauri spawning it as a sidecar conflicts with the service owning its lifecycle. Pick one owner. (Design note.)

### 6. Node SEA and alternatives
- Node 22 docs (v22.23.3): SEA is Stability **1.1 Active development** (not stable). Uses `node --experimental-sea-config sea-config.json` + `postject`. **CommonJS only** ("only supports running a single embedded script using the CommonJS module system"). Injected `require()` loads built-ins only, so you must bundle to one file. Source: https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html (checked 2026-10-03)
- Current docs (v26.10.0): still 1.1. `--build-sea` added in v25.5.0 (no postject needed). `mainFormat: "module"` (ESM) supported in newer versions (no `import.meta.resolve`). `useVfs` (v26.9.0, early development). Native addons can't load from VFS: write the asset to a temp file and `process.dlopen`. Cross-platform builds need `useCodeCache`/`useSnapshot` false. macOS CI tests arm64 only. Source: https://nodejs.org/api/single-executable-applications.html (checked 2026-10-03)
- postject is still `1.0.0-alpha.6` (last published 2023-05). Source: `npm view postject` (checked 2026-10-03)
- `bun build --compile` (bun 1.4.2): can embed `.node` N-API addons, cross-compiles linux/windows/darwin x64/arm64 (glibc/musl). On macOS it needs JIT entitlements. Source: https://bun.com/docs/bundler/executables (checked 2026-10-03)
- `@yao-pkg/pkg` 6.23.0: actively maintained; supports native addons, ESM, node22/node24, `--sea` mode, cross-compile. Official Tauri guide uses it. Source: https://github.com/yao-pkg/pkg ; https://v2.tauri.app/learn/sidecar-nodejs/ (checked 2026-10-03)
- Recommendation: use **bun build --compile** if the daemon depends on `@anthropic-ai/claude-agent-sdk`. The SDK documents a bun-specific path (`extractFromBunfs`, item 8), and bun embeds N-API addons. Second choice: `@yao-pkg/pkg`. Avoid raw Node 22 SEA (CJS-only, experimental, manual addon extraction). Where possible, use pure-JS/wasm crypto (`libsodium-wrappers` 0.8.4) instead of `sodium-native` 5.1.0 to cut per-platform native artifacts. Keychain still needs one native addon (`@napi-rs/keyring`), or shell out to OS tools. Bun's Node-API compatibility with `@napi-rs/keyring` specifically: UNVERIFIED (needs a smoke test).

### 7. OS keychain libraries
- `keytar` 7.9.0: repo `atom/node-keytar` is **archived** (last push 2022-12-12). Don't use it. Source: https://github.com/atom/node-keytar ; GitHub API (checked 2026-10-03)
- `@napi-rs/keyring` 2.1.0 (published 2026-09): wraps Rust `keyring-rs`. API: `new Entry(service, account)`, `.setPassword/.getPassword/.deletePassword`, `AsyncEntry`. Claims 100% keytar compatibility. Prebuilds: darwin x64/arm64, win32 x64/ia32/arm64, linux x64/arm64 gnu+musl, arm, riscv64, freebsd. Linux backend: Secret Service (gnome-keyring/KWallet/KeePassXC) by default, with a kernel keyutils fallback (in-memory until reboot). Source: https://github.com/Brooooooklyn/keyring-node ; `npm view @napi-rs/keyring optionalDependencies` (checked 2026-10-03)
- Secret Service needs a D-Bus session bus. A systemd --user daemon normally has one; headless or linger setups may not. Treat this as UNVERIFIED for specific distros.

### 8. @anthropic-ai/claude-agent-sdk packaging
- Version 0.3.288 (published 2026-10-03). `main: sdk.mjs` (ESM, `"type": "module"`), engines node >=18. **No bundled cli.js.** The CLI ships as a **native per-platform binary** through optionalDependencies `@anthropic-ai/claude-agent-sdk-{linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl,darwin-x64,darwin-arm64,win32-x64,win32-arm64}`. linux-x64 unpacks to about 245 MB. Source: `npm view` / `npm pack` of the package (checked 2026-10-03)
- The SDK spawns that `claude` binary as a subprocess (it does not need Node at runtime for the CLI). Option `pathToClaudeCodeExecutable?: string` overrides the location. The README section "Compiled binaries (`bun build --compile`)": `require.resolve` fails inside `$bunfs`, so embed it with `import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }`, extract with `extractFromBunfs` from `@anthropic-ai/claude-agent-sdk/extract`, and pass it as `pathToClaudeCodeExecutable`. Windows path is `/claude.exe`. Cross-compiling requires `npm install <platform pkg> --force`. A `/core` entry is offered for bundlers (zod ^4 and @modelcontextprotocol/sdk ^1.29 as peers). Source: package README in npm tarball, https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk (checked 2026-10-03)
- Implication: the sidecar will be at least about 250 MB per platform if you embed the CLI. Alternative: ship the `claude` binary as a second Tauri `externalBin` and pass its path via env/arg, which avoids extracting it to a temp dir at each start. Each extra binary must be signed/notarized on macOS.

### 9. three-vrm
- `@pixiv/three-vrm` 3.5.5 (2026-07-09). Peer dependency `three >=0.137`; current three is 0.186.1. WebGPU/`MToonNodeMaterial` needs r167+. Source: `npm view` ; https://pixiv.github.io/three-vrm/docs/ (checked 2026-10-03)
- VRM 1.0 `VRMExpressionPresetName`: `aa, ih, ou, ee, oh, blink, happy, angry, sad, relaxed, lookUp, surprised, lookDown, lookLeft, lookRight, blinkLeft, blinkRight, neutral`. Source: https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-core/src/expressions/VRMExpressionPresetName.ts (checked 2026-10-03)
- `vrm.expressionManager.setValue(name, weight)`, `getValue`, `getExpression`, `resetValues()`, `getExpressionTrackName`. Then call `vrm.update(delta)` each frame. Source: three-vrm-core 3.5.5 `types/expressions/VRMExpressionManager.d.ts` (checked 2026-10-03)
- LookAt: `vrm.lookAt.target?: Object3D` with `autoUpdate: boolean`, `lookAt(position: Vector3)` (overwritten if autoUpdate), `update(delta)`, `getLookAtWorldDirection`, etc. Source: three-vrm-core 3.5.5 `types/lookAt/VRMLookAt.d.ts` (checked 2026-10-03)
- VRM 0.x: loads through the same `VRMLoaderPlugin`. Preset names are mapped v0→v1: `a→aa, e→ee, i→ih, o→oh, u→ou, joy→happy, sorrow→sad, fun→relaxed, angry→angry, blink_l→blinkLeft, blink_r→blinkRight, lookup→lookUp…, neutral`. **VRM 0.x has no `surprised` preset.** Use `VRMUtils.rotateVRM0(vrm)` (VRM0 faces -Z). Source: three-vrm-core lib `v0v1PresetNameMap` ; https://pixiv.github.io/three-vrm/docs/ (checked 2026-10-03)
- `VRMUtils` statics: `combineMorphs`, `combineSkeletons`, `deepDispose`, `removeUnnecessaryJoints`, `removeUnnecessaryVertices`, `rotateVRM0`. Source: @pixiv/three-vrm 3.5.5 `types/VRMUtils/index.d.ts` (checked 2026-10-03)

### 10. OS service installers (user-level daemon)
- macOS: per-user agents go in `~/Library/LaunchAgents`, owned by the user. They run only while that user is logged in and get SIGTERM at logout. LaunchDaemons (`/Library/LaunchDaemons`, root) run without a user session. Keys: `RunAtLoad`, `KeepAlive`. Use a LaunchAgent so the daemon can reach the login keychain. Source: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html (checked 2026-10-03)
- Linux: user units go in `~/.config/systemd/user/`, enabled with `systemctl --user enable --now`. `loginctl enable-linger USER`: "a user manager is spawned for the user at boot and kept around after logouts". Without linger, user services stop when the user logs out. Source: https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml ; https://github.com/systemd/systemd/blob/main/man/loginctl.xml (checked 2026-10-03)
- Windows: **don't use a Windows Service.** LocalSystem "is not associated with any logged-on user account"; HKCU maps to the default user. Credential Manager `CredWrite` stores in "the user's credential set… associated with the logon session of the current token", so a SYSTEM service can't read the user's credentials without impersonation. Use per-user autostart instead: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` ("run when a user logs on"; the system may delay it), or a per-user Scheduled Task (logon trigger, restart on failure). Source: https://learn.microsoft.com/en-us/windows/win32/services/localsystem-account ; https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew ; https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys (checked 2026-10-03). Scheduled Task restart-on-failure semantics: UNVERIFIED (not fetched).
- Tauri has an official `autostart` plugin (LaunchAgent/registry/XDG autostart) for launching the GUI app itself. Its suitability for the daemon: UNVERIFIED.

### Deviations from the prompt
- **`macOSPrivateApi: true` is no longer required.** It is a no-op since Tauri 2.12.1 (2026-09-29); private APIs are always on. Mac App Store implications are therefore unclear for every Tauri app (UNVERIFIED whether wry now avoids private APIs for transparency).
- **`APPLE_APP_SPECIFIC_PASSWORD` is not a Tauri variable.** Use `APPLE_PASSWORD` (holding the app-specific password). App Store Connect API alternative: `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`.
- **EV certificates no longer give instant SmartScreen reputation** (Microsoft change, 2024). EV and OV are treated alike.
- "Azure Trusted Signing" is now documented as **Azure Artifact Signing** with `artifact-signing-cli` (previously `trusted-signing-cli`).
- **Node 22 SEA is not stable** (1.1) and is CJS-only. `--build-sea` arrived in Node **25.5.0** (not "Node 25" generically). Node 26 is current.
- **Claude Agent SDK no longer ships `cli.js`.** It spawns a roughly 245 MB native `claude` binary from platform optional deps, so single-executable packaging must embed/extract it or ship it as a separate sidecar.
- **`cursorPosition()` returns (0,0) on native Wayland,** so the polling click-through approach is broken there. Wayland needs an XWayland fallback.
- tauri-action is now `@v1`, and the updater JSON input is `uploadUpdaterJson` (not `includeUpdaterJson`).
- VRM 0.x models lack a `surprised` expression (no v0 equivalent).
- `skipTaskbar` is unsupported on macOS (use `ActivationPolicy::Accessory` to hide from the Dock; that API is UNVERIFIED here). `visibleOnAllWorkspaces` is unsupported on Windows. `shadow` is unsupported on Linux.

### Unverifiable / open
- Wayland always-on-top behavior per compositor (GNOME/KDE/wlroots): UNVERIFIED in official Tauri docs.
- Whether Tauri auto-signs `externalBin` sidecars during macOS bundling/notarization: UNVERIFIED.
- Exact naming for a universal macOS sidecar (`-universal-apple-darwin`) in current Tauri 2.12: UNVERIFIED (only historical issue #3355).
- Whether `@napi-rs/keyring` loads correctly inside a `bun build --compile` binary: UNVERIFIED, needs a smoke test.
- App Store acceptance of Tauri 2.12+ apps given always-on private APIs: UNVERIFIED.
- Secret Service availability for headless/lingering systemd --user daemons: UNVERIFIED (distro-dependent).
- Windows Scheduled Task restart semantics; Tauri autostart plugin specifics: not fetched.


---

## GCP, Stripe, Mercado Pago, Hono, Next.js/next-intl, MCP

All facts below come from official docs or the npm registry, checked on 2026-10-03. Anything marked UNVERIFIED could not be confirmed from an official source.
Note: Google Cloud docs moved from `cloud.google.com/.../docs` to `docs.cloud.google.com/...`, and the old URLs now 301-redirect there. In the docs, Vertex AI generative pages now appear under the "Gemini Enterprise Agent Platform" name.

### 1. Firestore TTL policies
- Deletion delay: "Data is typically deleted within **24 hours** after its expiration date." The 72h figure is wrong. Expired docs can still show up in queries until they are deleted, so filter on the TTL field in queries. Source: https://docs.cloud.google.com/firestore/native/docs/ttl (checked 2026-10-03)
- Field type: Standard edition needs a `Date and time` (Timestamp) value. Enterprise edition also accepts an array that contains a timestamp. If the field is missing, `null` or another type, that doc never expires (this is how you opt a doc out). Source: same.
- Scope: a TTL policy is set per **collection group**, with "only one field per collection group" as the TTL field. Source: same.
- Cost: "TTL delete operations count towards your document delete costs". TTL deletes are **not covered by the free tier**, and billing must be enabled to use TTL. Sources: same, plus https://firebase.google.com/docs/firestore/pricing and https://firebase.google.com/docs/firestore/quotas (checked 2026-10-03)
- Limits: 200 field configurations per database without billing, 1000 with billing. A TTL policy and an index exemption on the same field count as one. Source: https://firebase.google.com/docs/firestore/quotas (checked 2026-10-03)
- Terraform: `google_firestore_field` takes `collection` (the collection group id), `field`, an optional `database` (default `(default)`), and a `ttl_config {}` block. An empty block enables TTL, and the optional `expiration_offset = "2592000s"` sets an offset. Leaving the block out disables TTL. Source: https://github.com/hashicorp/terraform-provider-google/blob/main/website/docs/r/firestore_field.html.markdown (checked 2026-10-03)

### 2. Firestore realtime listeners, custom tokens, rules
- Listener billing: "charged for a read each time a document in the result set is added or updated". Docs that leave the result set because they changed are also billed, but deletions are not. If a listener is disconnected for more than **30 min**, the reconnect is billed as a brand-new query. Source: https://firebase.google.com/docs/firestore/pricing (checked 2026-10-03)
- Free tier per day: 50k reads, 20k writes, 20k deletes, 1 GiB stored, 10 GiB/month egress. One free database per project. Source: same.
- Listener and connection limits: the current quotas page lists **no** limit on concurrent listeners or connections per database. The older figures (1M concurrent connections per database, 100 listeners per client) are no longer in the docs, so treat them as UNVERIFIED. The scaling guide says only "Cloud Firestore scales automatically" and recommends the 5-5-5 ramp rule. Sources: https://docs.cloud.google.com/firestore/quotas and https://firebase.google.com/docs/firestore/real-time_queries_at_scale (checked 2026-10-03)
- Custom tokens: `createCustomToken(uid, developerClaims)`.
  - The custom token expires after **1 hour** and you cannot change that.
  - Reserved claims you cannot set: `acr, amr, at_hash, aud, auth_time, azp, cnf, c_hash, exp, iat, iss, jti, nbf, nonce, sub, firebase, user_id`.
  - On Cloud Run, signing with the auto-discovered service account needs `iam.serviceAccounts.signBlob` (the Service Account Token Creator role on itself).
  - The claims show up in rules as `request.auth.token.<claim>`.
  - Source: https://firebase.google.com/docs/auth/admin/create-custom-tokens (checked 2026-10-03)
- Persistent custom claims via `setCustomUserClaims`: max **1000 bytes**. They reach the client on the next ID token refresh. ID tokens last about 1 hour (the 1-hour ID token lifetime is general Firebase knowledge and was not re-fetched today). Source: https://firebase.google.com/docs/auth/admin/custom-claims (checked 2026-10-03)
- Rules for the three access patterns:
  - **Server-only collections**: use `allow read, write: if false;`. "The server client libraries bypass all Cloud Firestore Security Rules" and authenticate through IAM/ADC instead. Source: https://firebase.google.com/docs/firestore/security/get-started (checked 2026-10-03)
  - **Device-only writes**: check a custom-token claim, for example `request.auth.token.device_id == resource.data.deviceId`, or `request.auth.uid` when uid is `device:<id>`. This is an inferred pattern built from the documented claims and rules features.
  - **Membership**: use `exists(/databases/$(database)/documents/orgs/$(org)/members/$(request.auth.uid))` or `get(...)`. Limits: **10** document-access calls for single-doc requests and queries, **20** for multi-doc reads, transactions and batched writes. These calls are **billed reads even when the rule denies the request**. Rules are not filters. Function call depth is max 10. Source: https://firebase.google.com/docs/firestore/security/rules-conditions (checked 2026-10-03)

### 3. Identity Platform
- MFA second factors are **SMS and TOTP**. TOTP has been GA since 2023-09-21. Phone and anonymous sign-in cannot be used as the first factor for MFA. Email verification is required. Sources: https://docs.cloud.google.com/identity-platform/docs/web/mfa and https://docs.cloud.google.com/identity-platform/docs/release-notes and https://docs.cloud.google.com/identity-platform/docs/admin/enabling-totp-mfa (checked 2026-10-03)
- Enforcement: the MFA state enum is `DISABLED | ENABLED | MANDATORY`, where MANDATORY means "Users from this project must authenticate with the second factor". It can be set per project or per tenant. TOTP is configured with `adjacentIntervals` (0 to 10, default 5). In practice, enrollment UX is still the app's job: users who have not enrolled are prompted at sign-in. That last point is my inference and was not tested. Source: https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.tenants (checked 2026-10-03)
- Pricing:
  - Tier 1 (email, phone, anonymous, social): **0 to 50,000 MAU free**, then $0.0055/MAU up to 100k, $0.0046 up to 1M, $0.0032 up to 10M, $0.0025 above that.
  - Tier 2 (OIDC/SAML): 50 MAU free, then $0.015/MAU.
  - SMS (phone auth and MFA) is billed per message, with the first 10 SMS per day free. **Mexico: $0.05 per SMS.**
  - Source: https://cloud.google.com/identity-platform/pricing (checked 2026-10-03)
- Custom tokens are supported (same Admin SDK as above).
- Passkeys/WebAuthn: **no native support is documented**. Release notes have nothing on passkeys (the latest entry is 2024-12-03), and the `/identity-platform/docs/passkeys` page returns 404. The Firebase CLI notes mention only *mock* passkey support in the Auth emulator. Treat native passkeys as UNVERIFIED or unavailable, and plan WebAuthn yourself with custom tokens if you need it. Sources: https://docs.cloud.google.com/identity-platform/docs/release-notes and https://firebase.google.com/support/release-notes/cli (checked 2026-10-03)

### 4. Cloud Run domains, regions, billing; Cloud Tasks and Vertex availability
- Cloud Run domain mapping is **Preview** ("Pre-GA Offerings Terms… not production-ready"). It is available only in asia-east1, asia-northeast1, asia-southeast1, europe-north1, europe-west1, europe-west4, **us-central1**, us-east1, us-east4 and us-west1. **Not in us-south1 or northamerica-south1.** The documented alternatives are the global external Application Load Balancer (recommended) and Firebase Hosting. Source: https://docs.cloud.google.com/run/docs/mapping-custom-domains (checked 2026-10-03)
- Firebase Hosting rewrites to Cloud Run are supported in many regions, **including us-south1 and us-central1 but not northamerica-south1**. There is a hard **60-second request timeout**, with a 504 after that. Source: https://firebase.google.com/docs/hosting/cloud-run (checked 2026-10-03)
- Firebase App Hosting (Next.js 13.5+, Angular 18.2+) runs on Cloud Build, Cloud Run and Cloud CDN. Its regions are us-central1, us-east4, us-east5, asia-east1, asia-southeast1 and europe-west4, so **no us-south1 and no northamerica-south1**. Source: https://firebase.google.com/docs/app-hosting/about-app-hosting (checked 2026-10-03)
- Cloud Run itself is available in us-central1, us-south1 and northamerica-south1 (Mexico), all Tier 1 pricing. Source: https://docs.cloud.google.com/run/docs/locations (checked 2026-10-03)
- Billing:
  - Request-based billing is the default. You are charged only while an instance starts, shuts down, or handles at least one request, rounded up to 100 ms.
  - Free tier: 180,000 vCPU-s, 360,000 GiB-s and 2M requests per month.
  - Idle instances that are not min instances are not charged, so min instances = 0 means no idle cost.
  - Requests that IAM denies are not billed.
  - Source: https://cloud.google.com/run/pricing (checked 2026-10-03)
- Cloud Tasks locations include us-central1 and us-south1. **northamerica-south1 is not listed.** Source: https://docs.cloud.google.com/tasks/docs/locations (checked 2026-10-03)
- Vertex AI / Gemini:
  - The location page lists US regional endpoints, including us-central1 and **us-south1 (Dallas)**, plus a global endpoint. **northamerica-south1 is not listed for generative AI.**
  - Newer models such as `gemini-3.1-flash-lite` are offered only on **global plus the `us`/`eu` multi-regions**, not on single regions like us-central1.
  - Sources: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations and https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite (checked 2026-10-03)

### 5. Vertex AI Gemini global endpoint pricing, cheap model
- **Confirmed**: non-global (regional or multi-regional) endpoints cost **10% more** than global for GA Gemini 3+ models, **effective July 1, 2026**. The doc says: "For non-global endpoints, pricing will go into effect for the Generally available Gemini 3 and later families… starting on July 1, 2026." Examples: 3.1 Flash-Lite input is $0.25 global vs $0.275 non-global. Gemini 2.5 rows have no global/non-global split. Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (checked 2026-10-03)
- **`gemini-2.5-flash-lite` retires on 2026-10-20**, 17 days from today. Google lists `gemini-3.1-flash-lite` (or 3.8-flash / Gemma 4) as the replacement. Its price was $0.10 in / $0.40 out per 1M tokens. Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions (checked 2026-10-03)
- Current cheap models (standard tier, per 1M tokens, ≤200K context, global price):
  - **`gemini-3.1-flash-lite`** (GA, released 2026-05-07, retires no earlier than 2027-05-07): input (text/image/video) **$0.25**, audio in $0.50, output **$1.50**, cached input $0.025. Non-global: $0.275 / $1.65.
  - `gemini-3.5-flash-lite` (released 2026-07-21): $0.30 in / $2.50 out global.
  - Source: pricing and model-versions pages above, plus https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite (checked 2026-10-03)
- SDK: `@google/genai` latest is 2.27.0. Source: https://registry.npmjs.org/@google/genai (checked 2026-10-03)

### 6. Pub/Sub: BigQuery subscriptions, push to Cloud Run, DLQ
- BigQuery subscription schema modes:
  - **use topic schema** (Avro/Protobuf mapped to table columns)
  - **use table schema** (JSON message fields mapped to table columns)
  - **no schema**: the message lands in a `data` column (BYTES/STRING)
  - optional **write metadata**, which adds the `subscription_name, message_id, publish_time, attributes` columns. The column list is general knowledge. The docs page only says "system-generated fields".
  - CDC writes need `_CHANGE_TYPE` and `_CHANGE_SEQUENCE_NUMBER` and a primary key.
  - The Pub/Sub service agent needs **BigQuery Data Editor** and **BigQuery Read Session User**.
  - Failed writes can go to a DLQ, with the `CloudPubSubDeadLetterSourceDeliveryErrorMessage` attribute.
  - Billed per TiB written (Storage Write API).
  - Source: https://docs.cloud.google.com/pubsub/docs/bigquery (checked 2026-10-03)
- Push to Cloud Run with OIDC:
  - The subscription sets a push-auth service account and an optional `audience`.
  - That service account needs `roles/run.invoker` on the service.
  - The docs say the Pub/Sub service agent `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` needs `iam.serviceAccountTokenCreator`.
  - The JWT arrives as `Authorization: Bearer`. Cloud Run IAM validates it automatically when the service requires auth.
  - Source: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions (checked 2026-10-03)
- Dead-letter topics:
  - `maxDeliveryAttempts` is 5 to 100 (default 5) and is best effort.
  - The service agent needs **Publisher** on the DLT and **Subscriber** on the source subscription.
  - Forwarded messages get these attributes: `CloudPubSubDeadLetterSourceDeliveryCount`, `...SourceSubscription`, `...SourceSubscriptionProject`, `...SourceTopicPublishTime`.
  - Source: https://docs.cloud.google.com/pubsub/docs/handling-failures (checked 2026-10-03)

### 7. Stripe
- **API version and SDK**: the current API version is `2026-09-30.endive` and the `stripe` npm package is 23.0.0. Source: https://docs.stripe.com/billing/subscriptions/trials and https://registry.npmjs.org/stripe (checked 2026-10-03)
- **Trials changed**:
  - Stripe now recommends the new **Trial Offer API** (`/v1/product_catalog/trial_offers`, `items[].current_trial.trial_offer`). It needs `billing_mode[type]=flexible` and API version ≥ 2026-09-30.endive.
  - `trial_period_days` / `trial_end` are now labelled **legacy**, but they still work and are **required for Checkout**: "Checkout (instead use legacy free trials with `trial_end`)". Trial offers are not supported in Checkout, Payment Links or Elements with Checkout Sessions.
  - Source: https://docs.stripe.com/billing/subscriptions/trials (checked 2026-10-03)
- Legacy trial details:
  - `trial_period_days` can be at most **730 days**. A $0 invoice is created at the start.
  - When the trial ends, `invoice.created` fires and payment is attempted about 1 h later.
  - `trial_settings.end_behavior.missing_payment_method` takes `cancel`, `pause` or `create_invoice` (the default, which goes `past_due` if unpaid).
  - Checkout with no card: `mode=subscription`, `subscription_data[trial_period_days]=7`, `subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel`, `payment_method_collection=if_required`.
  - Events: `customer.subscription.trial_will_end` (by default 3 days before the end, configurable in the Dashboard; it fires immediately if the trial is shorter), plus `customer.subscription.paused`, `.resumed` and `.deleted`. Stripe-hosted reminder emails go out 7 days before.
  - Sources: https://docs.stripe.com/billing/subscriptions/trials/free-trials and https://docs.stripe.com/billing/subscriptions/trials (checked 2026-10-03)
- One-time payments use Checkout `mode=payment` (standard). Source: https://docs.stripe.com/payments/checkout (standard API, not re-fetched)
- Customer Portal:
  - Customers can update their payment method and billing details, change subscriptions (up to 10 products), cancel now or at period end, and see invoices.
  - Sessions expire 5 min after creation if unused, or 1 h after the last activity. The portal cannot be iframed.
  - By default, a change made in the portal during a trial **ends the trial**. Set `features.subscription_update.trial_update_behavior=continue_trial` to keep it.
  - Subscriptions that use trial offers or `send_invoice` can be cancelled in the portal but not updated.
  - Source: https://docs.stripe.com/customer-management (checked 2026-10-03)
- Webhooks: verify the `Stripe-Signature` header (format `t=…,v1=…`) with `stripe.webhooks.constructEvent(rawBody, sig, whsec)` on the **unmodified raw body**. The default timestamp tolerance is 5 min (standard library behaviour, not re-fetched). Source: https://docs.stripe.com/webhooks/signature (checked 2026-10-03)
- Idempotency: send an `Idempotency-Key` header on POSTs (up to 255 chars; V4 UUIDs recommended). Keys can be pruned after **24 h**. Reusing a key with different parameters errors. GET and DELETE do not need it. Source: https://docs.stripe.com/api/idempotent_requests (checked 2026-10-03)
- **Adaptive Pricing**:
  - It **does work with subscriptions**. The renewal PaymentIntents carry `presentment_details`, and "For cross-border subscriptions, Adaptive Pricing supports only card payments, Link, Apple Pay, and Google Pay."
  - MX is a supported customer market, so MXN presentment works. The exchange rate is guaranteed for 24 h. The customer pays a 2–4% conversion fee and the merchant pays 0%. The only excluded merchants are Indian businesses.
  - **Key catch**: "Adaptive Pricing requires the currency for your prices to be one of your settlement currencies."
  - Testing: use a `test+location_MX@example.com` email.
  - Source: https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted (checked 2026-10-03)
- **Settlement currency for a Mexican entity**: multi-currency settlement is only available in AE, AU, CH, EU, GB, HK, LI, NO, SG and US. **MX is not on the list**, so a Stripe MX account settles in MXN only.
  - A MX account *can charge in USD* (135+ presentment currencies), but those charges are converted to MXN with a +2% conversion fee.
  - Because USD is not a settlement currency for an MX account, **Adaptive Pricing would not apply to USD-denominated prices on a Stripe MX account**. Use MXN as the base price plus `currency_options` (manual multi-currency prices) for USD. This is my inference from the two docs and should be confirmed with Stripe support.
  - Sources: https://docs.stripe.com/payouts/multicurrency-settlement and https://docs.stripe.com/currencies (checked 2026-10-03)
- Stripe in Mexico: Stripe has a Mexican pricing page and local entity (stripe.com/mx). Fees, excluding IVA:
  - Domestic cards: **3.6% + MXN 3.00**
  - International cards: +0.5%
  - Currency conversion: +2%
  - Local methods / bank transfers: **4% + MXN 3.00**
  - MSI: from 5% extra (3 months)
  - Disputes: MXN 150
  - Source: https://stripe.com/mx/pricing (checked 2026-10-03)
- MX payment methods:
  - **Cards**: Visa, Mastercard, Amex and debit. Source: https://docs.stripe.com/currencies (checked 2026-10-03)
  - **OXXO**:
    - Customers must be in MX, and it is MXN only (MXN 10 to 10,000).
    - Vouchers expire in 1 to 7 days (default 5). Payments settle in up to T+4.
    - **Recurring is not supported. It does not work with Billing, Invoicing, Customer Portal or Adaptive Pricing.** There are no refunds or disputes.
    - Some MCCs are prohibited, including 5968 subscriptions and 6538. Check the MCC for a SaaS business.
    - So OXXO only works for one-time Checkout `mode=payment` in MXN.
    - Source: https://docs.stripe.com/payments/oxxo (checked 2026-10-03)
  - **SPEI** (bank transfer via `customer_balance`, MXN, MX accounts):
    - Works with Checkout `mode=payment` (a Customer is required), but **not with Checkout in subscription mode**.
    - Subscriptions and Invoicing are supported only with `collection_method=send_invoice`. Not supported in the Customer Portal.
    - Unreconciled funds are returned after 75 days.
    - Source: https://docs.stripe.com/payments/bank-transfers (checked 2026-10-03)
  - **Meses sin intereses**:
    - MX accounts, Mexican-issued credit cards, MXN only.
    - Supported in Payment Intents, Checkout, Invoicing, Payment Element and Payment Links.
    - Minimums and fees: 3m needs MXN 300 (+5%), 6m MXN 600 (+7.5%), 9m (+10%), 12m (+12.5%), 18m (+17.5%), 24m MXN 2,400 (+22.5%).
    - Use with subscriptions is UNVERIFIED (the docs say "Pagos recurrentes: Sí" but do not list Billing).
    - Source: https://docs.stripe.com/payments/mx-installments (checked 2026-10-03)
- **Sandboxes vs test mode**: "For new integrations, use general sandboxes instead of your test mode sandbox." Test mode still exists as the "test mode sandbox". Use separate sandboxes for local dev and CI. `stripe sandbox create` can create an anonymous sandbox. IC+ pricing cannot be tested in a sandbox. Source: https://docs.stripe.com/sandboxes (checked 2026-10-03)

### 8. Mercado Pago (enough to stub an adapter)
- Subscriptions: create a plan with `POST /preapproval_plan`. Fields: `reason`, `auto_recurring{frequency, frequency_type:'months', transaction_amount, currency_id:'MXN', free_trial{frequency, frequency_type}}` and `back_url`. Then create a subscription with `POST /preapproval`, passing `preapproval_plan_id`, `card_token_id`, `payer_email`, `status:'authorized'` and `external_reference`. Free trial is supported in the plan. Source: https://www.mercadopago.com.mx/developers/en/docs/subscriptions/integration-configuration/subscription-associated-plan (checked 2026-10-03)
- Checkout Pro (one-time):
  - Create a preference with `items`, `back_urls`, `notification_url` and `external_reference`, then redirect to `init_point`.
  - MX payment methods: cards, SPEI, OXXO, Paycash, bank branches, Mercado Pago account balance, and installments without a card.
  - Source: https://www.mercadopago.com.mx/developers/en/docs/checkout-pro/overview (checked 2026-10-03)
- Webhook signature:
  - Header: `x-signature: ts=<ts>,v1=<hex>`.
  - The manifest string is `id:[data.id];request-id:[x-request-id];ts:[ts];`, with `data.id` lowercased. Verify it with HMAC-SHA256 using the app's webhook secret.
  - Respond 200/201 quickly. Failed deliveries are retried.
  - Topics: `payment`, `subscription_preapproval`, `subscription_authorized_payment` (these topic names are from memory; the page summary confirmed only the "preapproval/authorized payments" categories, so confirm the exact strings).
  - Source: https://www.mercadopago.com.mx/developers/en/docs/your-integrations/notifications/webhooks (checked 2026-10-03)
- SDK: `mercadopago` npm 3.6.1. Source: https://registry.npmjs.org/mercadopago (checked 2026-10-03)

### 9. HTTP framework for Cloud Run TS services
- Versions:
  - `hono` 4.13.12 (2026-09-30)
  - `@hono/node-server` **2.1.3** (requires Node ≥20; the 1.x line is now `latest-1`)
  - `@hono/zod-validator` 0.9.1
  - `fastify` 5.12.5 (v6 is in alpha: `6.0.0-alpha.4`)
  - `fastify-type-provider-zod` 7.0.0
  - `zod` 4.6.5
  - Source: https://registry.npmjs.org/ (checked 2026-10-03)
- Hono on Node: `serve(app)` wraps `node:http` and returns the server, so you write the SIGTERM shutdown yourself. Raw Node objects are at `c.env.incoming`. For the Stripe raw body, `await c.req.text()` (or `arrayBuffer()`) works. Source: https://hono.dev/docs/getting-started/nodejs (checked 2026-10-03; that page still says Node 18.14+, but the node-server 2.x package requires Node ≥20)
- Fastify v5 supports Node 20 and 22. v4 reached end of LTS on 2025-06-30. Source: https://fastify.dev/docs/latest/Reference/LTS/ (checked 2026-10-03)
- The MCP TS SDK v2 ships official thin adapters for **both** (`@modelcontextprotocol/hono` 2.0.2 and `@modelcontextprotocol/fastify`), so either choice works for MCP. Source: https://github.com/modelcontextprotocol/typescript-sdk (checked 2026-10-03)
- Recommendation: **Hono + @hono/node-server 2.x + @hono/zod-validator (Zod 4)**.
  - It uses Web-standard Request/Response, so the same handlers run on Cloud Run, in tests (`app.request()`) and anywhere else.
  - It starts faster and has a smaller footprint for scale-to-zero, gets the raw body easily for webhooks, and has an official MCP adapter.
  - Fastify is the better pick only if you want its plugin ecosystem or JSON-schema serialization.
  - On Cloud Run, raw throughput differences do not matter much. I did not find an official benchmark, so I am not making performance claims.

### 10. next-intl and Next.js
- Versions: `next` **16.3.8** (Node ≥20.9) and `next-intl` **4.14.9** (peer `next ^12 to ^16`). Source: https://registry.npmjs.org/ (checked 2026-10-03)
- Next.js 16: "The `middleware` file convention is deprecated and has been renamed to `proxy`". You export `proxy` (or a default export) from `proxy.ts`. Proxy **defaults to the Node.js runtime**, and setting `runtime` throws. A codemod is available: `npx @next/codemod@canary middleware-to-proxy .`. Source: https://nextjs.org/docs/app/api-reference/file-conventions/proxy (checked 2026-10-03)
- next-intl setup:
  - Files: `src/i18n/routing.ts` (`defineRouting` from `next-intl/routing`), `src/proxy.ts` ("was called `middleware.ts` up until Next.js 16") using `createMiddleware(routing)` from `next-intl/middleware`, `src/i18n/navigation.ts` (`createNavigation`), `src/i18n/request.ts`, and pages under `src/app/[locale]/`.
  - The matcher skips `/api`, `/trpc`, `/_next`, `/_vercel` and paths containing a dot.
  - Source: https://next-intl.dev/docs/routing/setup (checked 2026-10-03)
- `localePrefix: 'as-needed'` with `defaultLocale: 'es'` and `locales: ['es','en']`:
  - `/about` serves ES and `/en/about` serves EN. A redundant `/es/about` redirects to `/about`.
  - The matcher must catch unprefixed paths.
  - The locale cookie can redirect `/` to `/en`. Set `localeDetection: false` (or configure the cookie) if ES must always be the bare `/`.
  - Source: https://next-intl.dev/docs/routing/configuration (checked 2026-10-03)

### 11. MCP authorization and TS SDK
- The **current spec revision is `2026-07-28`**, so it is no longer 2025-06-18 or 2025-11-25. This revision drops the initialize handshake: each request carries its version in `_meta`, Streamable HTTP sends an `MCP-Protocol-Version` header, and there is a new mandatory `server/discover` RPC. Source: https://modelcontextprotocol.io/specification/versioning (checked 2026-10-03)
- Authorization (2026-07-28):
  - Based on OAuth 2.1 (draft-13). PKCE is required in the flow.
  - Servers **MUST** implement RFC 9728 Protected Resource Metadata and return a 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="…"`.
  - The AS must offer RFC 8414 or OIDC discovery, and clients must support both.
  - **Client ID Metadata Documents are SHOULD. Dynamic Client Registration (RFC 7591) is MAY and explicitly *deprecated*** (kept for backwards compatibility). Client ID options in order: CIMD, pre-registration, DCR.
  - RFC 8707 `resource` is MUST in both the auth and token requests.
  - Servers MUST validate the token audience and MUST NOT accept or pass through other tokens.
  - RFC 9207 `iss` validation on the auth response.
  - 403 `insufficient_scope` triggers step-up auth.
  - Source: https://modelcontextprotocol.io/specification/latest/basic/authorization (checked 2026-10-03)
- TypeScript SDK:
  - **v2 is the stable line** and implements 2026-07-28. It is split into `@modelcontextprotocol/server` **2.3.0** and `@modelcontextprotocol/client` 2.3.0, plus middleware packages `@modelcontextprotocol/node` 2.1.1, `/express` 2.0.2, `/hono` 2.0.2 and `/fastify`.
  - Schemas use Standard Schema (Zod v4 works). It requires Node ≥20.
  - The legacy `@modelcontextprotocol/sdk` is **1.32.0** (v1) and gets fixes for at least 6 months after v2.
  - Streamable HTTP is included in the server package (the Node wrapper is `@modelcontextprotocol/node`).
  - Sources: https://github.com/modelcontextprotocol/typescript-sdk (README) and https://registry.npmjs.org/@modelcontextprotocol/server (checked 2026-10-03)

### Deviations from the prompt
1. **Firestore TTL** deletes typically happen within **24 h**, not 72 h. Deletes are billed and are not in the free tier.
2. **Regional Gemini +10%**: correct, but only for GA Gemini 3+ models and only since 2026-07-01. It does not apply to 2.5 models.
3. **gemini-2.5-flash-lite retires 2026-10-20.** Use **`gemini-3.1-flash-lite`** ($0.25/$1.50 global). It is offered **only on global and the us/eu multi-regions, not us-central1**, so "regional" in practice means the `us` multi-region at +10%.
4. **Cloud Run domain mapping** is Preview and not available in us-south1 or northamerica-south1. Firebase Hosting rewrites do not cover northamerica-south1 and have a 60 s cap. App Hosting has no us-south1 or northamerica-south1. **Cloud Tasks and Vertex generative AI are not in northamerica-south1.** If you want everything in one region, us-central1 is the safest choice. Use a global ALB if a Mexico region is required.
5. **Stripe trials**: `trial_period_days` is now "legacy". The Trial Offer API is recommended but **not supported in Checkout**, so Checkout-based trials still use the legacy params.
6. **Adaptive Pricing + USD prices on a Stripe MX entity probably does not work**: MX accounts settle only in MXN, and Adaptive Pricing requires the price currency to be a settlement currency. Options: (a) MXN base price with USD `currency_options`, or (b) a US entity (Stripe Atlas or similar) for USD-based Adaptive Pricing.
7. **OXXO cannot be used for subscriptions** (no recurring, no Billing). SPEI cannot be used with Checkout in subscription mode. Both are fine for one-time MXN Checkout payments.
8. **Sandboxes**: Stripe recommends general sandboxes over the test-mode sandbox for new integrations.
9. **MCP**: the latest revision is **2026-07-28**. DCR is deprecated in favour of CIMD. The TS SDK has moved to the v2 split packages (`@modelcontextprotocol/server`), so `@modelcontextprotocol/sdk` is now legacy v1.
10. **Next.js 16**: the `middleware.ts` → `proxy.ts` rename is confirmed and proxy runs on the Node runtime. `@hono/node-server` is now 2.x and needs Node ≥20.
11. **Identity Platform passkeys**: no native support is documented.

### Unverifiable / open
- Firestore limits on concurrent listeners or connections per database: not in the current docs (UNVERIFIED).
- Whether MANDATORY MFA blocks users who have not enrolled or forces enrollment at sign-in: UNVERIFIED. Test it in a dev tenant.
- MSI combined with Stripe Billing subscriptions: UNVERIFIED.
- Adaptive Pricing on a Stripe MX account with USD prices: inferred to be unsupported. Confirm with Stripe support.
- OXXO MCC 6538 prohibition and how it applies to a SaaS MCC (5734/5817/7372): check during account onboarding.
- Mercado Pago exact webhook topic strings and response timeout (seconds): UNVERIFIED from the summarized page.
- Whether `iam.serviceAccountTokenCreator` on the Pub/Sub service agent is still needed for new projects: the docs say it is. Not re-tested.
- Hono vs Fastify performance on Cloud Run: no official benchmark consulted.
- Native passkey support in Identity Platform: no official statement either way (treat as unavailable).

---

## Chalyb hub engine contract (internal)

Read read-only on 2026-10-03 from `picassoglitch/chalyb` at `origin/claude/landing-clip-images` (`4ed57c9`, the branch on prod): `docs/engines/consumption-contract.md`, `docs/infra/adding-an-engine.md`, `src/lib/engines/integrations/factory.ts`, `src/app/auth/launch/[slug]/route.ts`, `src/config/pricing.ts`.

- **Provisioning:**
  - `POST {admin_api_base}/tenants` with `Authorization: Bearer <SLUG>_ADMIN_TOKEN`, body `{external_user_id, email, display_name, tier}`. Returns `{tenant_id, api_token}` (200/201). A 409 `{error:'duplicate', tenant_id, api_token}` counts as success.
  - `POST /tenants/{tenant_id}/status {status:'active'|'paused'}` → 200/204.
- **SSO:** `GET {external_url}/auth/sso?token=<hmac>&next=<relative>`.
  - Token = `base64url(JSON{user_id,email,tenant_id,tier,exp}) + "." + base64url(HMAC-SHA256(secret, body))`. The default TTL is 300 s, and the secret is `<SLUG>_SSO_SECRET`.
  - `next` must be rejected if absolute or off-origin.
  - The hub only launches to `active` engines. New engines ship `coming_soon` via a migration.
- **Consumption** (`{CHALYB_BASE_URL}/api/engines/{slug}`, engine bearer):
  - `POST /usage/admit` takes `{external_user_id, external_job_id, class: job|stream, operation, est_tokens, upload_mb, source_minutes, storage_mb_after, boost, ttl_seconds}` and returns `{allowed, reservation_id, lane: standard|boost, boost_fee_tokens, limits, balance}`. A refusal returns `{allowed:false, reason}`, where `reason` is one of `upload_too_large`, `video_too_long`, `storage_full`, `minutes_cap`, `jobs_cap`, `concurrency`, `streams_cap`, `no_tokens` or `boost_unavailable`. Re-admitting the same `external_job_id` updates the reservation. Reservations expire (TTL, default 3 h); `heartbeat` extends them.
  - `POST /usage`:
    - At most 100 events. `amount` is an integer from 0 to 10^12. `cost_usd_micros` is an integer from 0 to 10^9 and is **required on every event**.
    - `occurred_at` must be within the last 7 days and no more than 5 min in the future.
    - Optional `reservation_id`. For `llm.tokens`, `metadata.tokens {input, output, cache_read, cache_write}` must sum to `amount`.
    - Idempotent on `(engine, source_id)`. A 4xx other than 408/429 is permanent (mark dead and alert).
  - `POST /usage/settle {reservation_id, outcome: succeeded|failed|cancelled|heartbeat}`. Settling twice is a no-op.
  - Billing: `billable_tokens = max(1, ceil(cost_usd_micros × (1 + margin) / 4))`. The margin is `app_settings.usage_margin_percent`, default 160%, and is frozen per event. 4 micros = $4 per 1M billable tokens. `boost.fee` events are already a price: `ceil(cost/4)`.
  - Meter kinds documented today: `llm.tokens`, `transcription.seconds`, `compute.seconds`, `storage.gb_month`, `stream.minutes`, `engine.base`. **Chalito's `voice.seconds`, `call.seconds`, `whatsapp.messages`, `sms.segments` and `store.purchase` must be confirmed or added on the hub (D-030).**
  - `compute.seconds` list rates (us-central1): standard 4 vCPU/8 GiB = 88 µ$/s, boost 8 vCPU/32 GiB = 208 µ$/s.
- **Infra:**
  - A new engine = one `engines` map entry in Chalyb's `infra/terraform/terraform.tfvars`: SA, 3 secrets, public scale-to-zero Cloud Run, bucket access, domain mapping `<slug>.chalyb.com`.
  - Workers need `cpu_idle = false`. Scheduled jobs default to paused.
- **Hub pricing (MXN, before 16% IVA):** Pro $749/mo, $7,490/yr; VIP $2,499/mo; packs 100k $149, 500k $599, 2M $1,999. The trial and its rules live in `PRICING.trial`; Chalito follows them (D-026).
