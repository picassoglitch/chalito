# ADR 0023: Agent connector catalog (the user's MCP tools for their agents)

- Status: Proposed (M17 docs, 2026-10-16). Nothing is built until the owner's "go".
- Builds on: the tool gate (PreToolUse hook, ACP permission requests), local policy (ADR 0008), the MCP gateway (ADR 0009, which is the other direction), signed recipes (ADR 0022 §4), revoke-all (ADR 0020).
- Protocol: `v` stays 1. New schemas `ConnectorRecipe`, `ConnectorGrant`; new commands `connector.*`; new audit category `connector.*`.

## Context
Owner decision (2026-10-16): agents run by Chalito should be able to use the user's tools (GitHub, Slack, Linear, Supabase, Postgres, Google Drive and so on).

Today every agent Chalito starts is isolated on purpose:
- Claude Code runs with `strictMcpConfig: true`, `settingSources: []` by default, and its own profile (`CLAUDE_CONFIG_DIR`). The only MCP server it gets is Chalito's local computer-control server.
- ACP agents get only what Chalito passes in `session/new` `mcpServers` (the computer-control server since M16 A).
- Codex runs under `codex app-server` with Chalito's config.
- Chalito never reads `~/.claude`, `~/.cursor` or a user's own MCP config (ADR 0022 "Not doing").

So an agent can't reach any outside tool unless the user types credentials into a prompt. That's both useless and unsafe. The fix is a catalog that keeps the isolation and adds tools one at a time, on purpose.

Not to be confused with ADR 0009: the gateway lets *outside chats* reach Chalito. This ADR lets *Chalito's agents* reach outside tools.

## Decision

### 1. A signed catalog of connector recipes
- `packages/config/connectors.yaml`, signed like the agent recipes and shipped with the agent. Each entry:

| Field | Meaning |
|---|---|
| `id` | `github`, `slack`, `linear`, `supabase`, `postgres`, `gdrive`, … |
| `transport` | `remote` (streamable HTTP MCP server run by the vendor) or `stdio` (a pinned local server package) |
| `server` | the vendor URL, or the package name + exact version + integrity hash |
| `auth` | `oauth` (MCP authorization, PKCE, `resource` param) or `token` (a personal access token / connection string) |
| `tools.read` / `tools.write` | the tool names in each tier; anything unlisted is **write** |
| `risk` | default risk class per tool for the gate (LOW / MED / HIGH) |
| `verified` | the date and version we last checked it |

- Preference order: the vendor's **official remote MCP server** (GitHub, Linear, Slack, Supabase and others publish one), then an official stdio package, then nothing. Community servers are not added in beta.
- A tool that isn't in the catalog can be added only locally, as a "custom connector", with the same OS-auth + typed confirmation as a hand-off link (ADR 0022 §3), and is marked unverified everywhere.

### 2. Credentials stay on the device
- `token` connectors: the secret goes into the OS keychain under `chalito.connector.<id>.<account>`. It is passed to a stdio server through its `env`, or as a header by Chalito's local MCP proxy (§4). It never goes into a prompt, a session event, the cloud or a log.
- `oauth` connectors: the device runs the authorization flow itself (loopback redirect, PKCE). Access and refresh tokens are stored in the keychain. The cloud never sees them.
- The phone can ask for a connector to be set up, but the OAuth window or token entry happens on the device (credentials are typed where they're used).
- Revoke deletes the keychain entries and, for OAuth, calls the vendor's revocation endpoint when it has one.

### 3. Grants: one approval per connector, scopes per session
- **Connector grant** (`ConnectorGrant`, signed, in `~/.chalito/connectors.json`, signed like `links.json`): the owner allows connector X for a project or repo (path or remote), with a tier ceiling (`read` or `read+write`) and an expiry (default 30 days). Made on the device or from a trusted client with passkey step-up. Write tier from a remote client is allowed, but the gate still applies (§5).
- **Session scope:** when a session starts, the owner (or the task template, ADR 0027) picks which granted connectors it gets and at which tier, at most the grant. Default: none. The Session Card lists them.
- A connector is passed to the agent only for that session:
  - Claude Code: added to `mcpServers` next to computer control. `strictMcpConfig` stays on, so nothing else leaks in.
  - ACP: added to `session/new` `mcpServers`.
  - Codex: per-thread MCP config through app-server, if the pinned version supports it; otherwise Codex sessions get no connectors (documented, not hacked).
  - `chat-api` sessions: only through the gated computer-control path, when the model supports tools.

### 4. Every call through the gate, through a local proxy
- Chalito runs one local MCP proxy per session (`apps/agent/src/connectors`). The agent talks to the proxy; the proxy talks to the vendor server.
- The proxy filters `tools/list` to the session's tier (write tools don't even appear on a read session), and stamps each call with the connector, tier and risk.
- Claude Code calls still hit the PreToolUse hook (tool names `mcp__<id>__<tool>`). ACP calls still hit the ACP permission request. The proxy is a second check, not a replacement.
- Default risk: read tools LOW (auto-allowed only on signed-origin turns, as today), write tools MED, destructive tools (delete, merge, drop, send to a channel) HIGH with passkey. `agent:`, `mcp:` and `call:` turns never auto-allow a connector call (relayed-origin rule).
- Responses from tools are **data**. The proxy wraps text results in the same quoted frame as link data when the agent supports it, and caps result size (default 64 KB, configurable per connector).

### 5. Audit
- Every grant, scope choice, tool call (connector, tool, tier, decision, size, latency) and revoke is an audit row in its own category `connector.*`. Arguments and results are never stored in the clear; only a hash and sizes.
- The phone shows a per-session "tools used" list. Revoke-all (ADR 0020) revokes every connector grant and deletes the keychain entries.

## How it relates to the existing isolation
| Rule today | After this ADR |
|---|---|
| `strictMcpConfig: true`, Chalito's own profile | Unchanged. Connectors are added explicitly per session; the user's own `~/.claude` MCP config is still never read. |
| Only the computer-control MCP server | Computer control plus the session's granted connectors, all behind the same gate. |
| Credentials only in the keychain | Same: connector secrets join the API keys there. |
| Relayed origins never auto-approve | Same for connector calls. |

## Consequences
- Agents become useful on real work (open a PR, read a Linear issue, query a staging database) without the user pasting secrets.
- `docs/THREAT_MODEL.md` gains §4.8g: tool-result prompt injection (mitigated by quoted results, tiers and the gate), token theft from the keychain (same as API keys), a malicious or updated stdio server (pinned version and hash, signed catalog), and data exfiltration through a write tool (write tier off by default, HIGH for send/post tools).
- Remote MCP servers change. Each catalog entry is re-verified before release (`verified` field), like `VERIFIED_APIS.md`.

## Not doing
- Reading the user's own MCP configuration or other apps' tokens.
- A cloud-side tool runner. Tool calls run on the device.
- Community servers in the default catalog during beta.
