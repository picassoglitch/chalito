# ADR 0022: Chalito Link (one language for every AI, agent-to-agent links)

- Status: Proposed (M16 docs, 2026-10-15). Nothing is built until the owner's "go".
- Builds on: the adapter contract (`packages/adapters/src/core.ts`), the ACP adapter and recipe engine (#4/#5, apps-engine), the MCP gateway (ADR 0009), Rooms (ADR 0010), local policy and Developer mode (ADR 0008), remote screen (ADR 0021).
- Protocol: `v` stays 1. New origins `agent:<sessionId>` and `a2a:<clientId>`, new schemas `LinkTask`, `LinkMessage`, `LinkArtifact`, `AgentLink`, `AgentCard`, new commands `link.*`, new recipe driver kinds `chat-api` and `a2a`.

## Context
Owner request (2026-10-15): Chalito should connect **every available AI tool and chat**, not only the ones in today's catalog, through a common standard, so that all of them can work together. The owner wants both kinds of agent-to-agent communication (sharing information only, and handing off work), and both the efficiency fixes and the new connection layer. **No browser automation of chat websites** (that's already a ground rule: no scraping or driving consumer UIs).

What exists on `main` (0b3beed):
- One `SessionAdapter` contract with these drivers:
  - Claude Code via the Agent SDK.
  - Codex via `codex app-server`.
  - A generic **ACP** adapter: Grok, Gemini, OpenCode, Goose, Qwen Code, Copilot CLI and Mistral Vibe through recipes.
  - The terminal, web-app and desktop-app drivers.
- The MCP gateway lets ChatGPT and Claude chats read cards, post to Mesa and (opt-in) prompt a session.
- Agents **cannot reach each other**:
  - Origins are only `local`, `client:`, `mcp:` and `call:`.
  - Rooms carry no instructions.
  - Mesa only reads session cards.
- Devices reach each other only through the cloud. A command has one `targetDeviceId`.

Gaps found in the 2026-10-15 read of `main`:
1. `agent-core.ts` never closes sessions, so each session's CLI process lives until the agent restarts.
2. `session.resume` works only for sessions still in memory. `providerSessionId` is stored but never passed to `adapter.start`.
3. No partial streaming:
   - Claude Code sends whole text blocks.
   - Codex buffers deltas per item.
4. Every event is a sealed `session_events` insert, then a trigger, then a broadcast pointer, then an HTTP pull. That is about two round-trips per event, capped near 20 events/s per device, which is a poor fit for terminal output.
5. ACP sessions don't get the computer-control MCP server. Cursor's `cursor-agent acp` recipe has not been probed.
6. No adapter for providers that only offer a chat API, and none for agents that speak A2A.

## Standards we adopt (we don't invent one)
| Standard | Role in Chalito | State (checked 2026-10-15; re-verify in `docs/VERIFIED_APIS.md` when building) |
|---|---|---|
| **ACP** (Agent Client Protocol) | Chalito → local coding agents | Already our generic adapter. About 25 agents. Claude Code and Codex reach it mostly through bridges, which we don't need since we have dedicated adapters. |
| **MCP** | AI → tools; outside chats → Chalito | Already used: the gateway (spec 2026-07-28) and the local computer-control server. |
| **A2A** (Agent2Agent) | Agent ↔ agent, inside Chalito and with outside systems | v1.0 (March 2026), v1.0.1 (May 2026), Linux Foundation, 150+ organizations. |
| **OpenAI-compatible chat API** | Providers with only a chat endpoint (xAI, DeepSeek, Mistral, Ollama, LM Studio…) | De facto standard (`/v1/chat/completions`, `/v1/responses`). |

**Rule:** if a tool speaks one of these, connecting it is a **recipe, not code**. Code is only written for a new standard, or for a widely used tool that speaks none of them.

## Decision

### 1. Phase A: efficiency fixes (no protocol change)
- **Session lifecycle:**
  - Idle sessions close after `session.idleTimeout`, set in `packages/config` (default proposed: 30 min idle), with a cap on live sessions per device.
  - A closed session keeps its `providerSessionId`.
  - `session.resume` and agent restarts pass it to `adapter.start({ resume })`: Claude SDK `resume`, Codex `thread/resume`, ACP `session/load|resume` where the agent advertises it.
- **Partial streaming:**
  - Claude Code: `includePartialMessages`.
  - Codex and ACP: deltas flushed at most every 150 ms or 512 chars.
  - A new `message.assistant.delta` event is broadcast-only, never stored. The final `message.assistant` is stored as today.
- **Fast live path:**
  - Live-only events (deltas, `terminal.output`, `screen.state`) go **sealed, straight over the private realtime topic** (`device:<id>`, the same RLS and recipients as today).
  - Durable events are still stored, but in **batches** (up to 250 ms or 32 events per insert).
  - A client that joins late resyncs from the stored rows exactly as today, so nothing durable depends on the broadcast.
  - Target: 100 events/s per device, with database writes down at least 5× on terminal sessions.
- **Parity:**
  - ACP sessions get the computer-control MCP server through `session/new` `mcpServers`, with the same per-session approval as #31.
  - Probe `cursor-agent acp` and either mark the recipe verified or document why not.

### 2. Phase B: one message format shaped like A2A
- New `packages/protocol/src/link.ts` with these schemas, which map one-to-one onto A2A v1 objects:
  - `LinkTask`: id, contextId, status (`submitted | working | input-required | auth-required | completed | failed | canceled | rejected`), history and artifacts.
  - `LinkMessage`: role, parts (text | data | file ref), messageId, taskId and contextId.
  - `LinkArtifact`.
  - `AgentCard`: name, skills, input/output modes and auth. It's generated from the recipe.
- Every adapter's `AdapterEvent` stream is projected onto `LinkTask` updates. A session is a long-lived `contextId`, and each prompt is a task.
- The current `AgentEvent`s stay the wire format to phones (no client break). `link.ts` is the format between agents and to the outside. One converter lives in `packages/protocol`.
- **Why A2A's shape:** if we use it internally, exposing Chalito as an A2A server (Phase D) needs no translation, and any A2A agent anywhere can join later.

### 3. Phase C: agent-to-agent links, in two modes (owner: "both options")
A link is an owner-made, explicit permission for **one agent to reach another**. There are no links by default.

| | **Share** (Rooms rule) | **Hand-off** |
|---|---|---|
| What the sender can do | Send information: a status, a result or a file reference | Ask the other agent to **do work** (create a `LinkTask`) |
| What the receiver sees | A quoted data block. It is never treated as an instruction (same hygiene as Rooms) | A prompt with origin `agent:<sessionId>`, wrapped in a fixed frame naming the sender, the link and the owner's goal |
| Who creates the link | Any trusted client, with step-up | **Only locally on the device** (desktop panel or `chalito link add`), like Developer mode (ADR 0008), because it loosens policy |
| Revoke | From anywhere, instantly. Revoke-all includes links (ADR 0020) | Same |

Guardrails for hand-off links:
- `agent:*` is a **relayed origin**:
  - It is never eligible for Developer-mode auto-approve.
  - The tool gate runs exactly as today, so every risky tool still needs the owner's signed approval.
- The receiving session's permission mode is **at most** the link's ceiling, which is at most local policy.
- **Scope:** each link names a sender (recipe, device or session), a receiver, a working directory or repo, an expiry, a token budget per day (billed through the hub contract as today) and a rate limit.
- **Loops:**
  - Each task carries a hop count, and work stops after **2 hops** (A → B → C).
  - A task can't come back to a session already in its chain.
  - Every hand-off is in the audit log and shows on the phone.
- **Confirm toggle:** per link, either "ask me each time" (one tap on the phone, the **default**) or "automatic".
- The result goes back to the sender as a `LinkArtifact` in **quoted data**. A result can never instruct the sender.
- Links run across devices through the existing command path: a signed `RelayedCommand` with origin `agent:`, aimed at the receiver's `targetDeviceId`.
- **Session tools (M16 F):** a running agent starts a hand-off or a share itself with `link_handoff` / `link_share` (and reads its links with `link_list`), from Chalito's local MCP server `chalito_links`.
  - Attached to Claude Code, Codex, ACP and chat-api sessions **only when the session is the sender on at least one active link** (a session started before its link gets them at its next start or resume).
  - Every call goes through the tool gate first: a hand-off or share always asks the phone (MED, one tap). Developer mode and LOW auto-allow never apply, whatever the turn's origin or `mcp.readOnlyTools`. The broker only runs a call the gate allowed (one-shot ticket), so the token alone can't skip it.
  - Then the link manager runs the same checks as the panel's hand-off: only the session's own sender links in the tool's mode, hop and chain, the receiver's authorization, rate, budget and the confirm toggle. The tool returns the `LinkTask` id; the result comes back as quoted `LinkArtifact` data with the owner's next prompt.

This **amends ADR 0010** only for coding agents with an explicit link. Rooms between companions keep "no kind that carries an instruction".

### 4. Phase D: connect everything
- **Recipe driver `chat-api`**:
  - Any OpenAI-compatible endpoint (base URL, model and key in the device keychain), shown as a session in Chalito.
  - Text by default. Tools only through Chalito's gated local MCP servers (computer control; the link tools of §3) when the model supports tool calls.
  - Covers xAI, DeepSeek, Mistral, Groq, OpenRouter and local models (Ollama, LM Studio).
  - Uses the user's own keys only. Chalito-paid usage goes through hub admit/settle as in M9.
- **Recipe driver `a2a`:**
  - A remote A2A agent (URL plus Agent Card) runs as a session, through the A2A client (JSON-RPC or HTTP+JSON per the card).
  - It can be the receiver of a link.
- **Chalito as an A2A server:**
  - One endpoint per user publishes Agent Cards for the agents the owner chooses to expose.
  - Callers authenticate with the M10 OAuth server and get origin `a2a:<clientId>` (relayed, like `mcp:`).
  - A caller can only create tasks on exposed agents, inside a link-style scope.
  - It's off by default. The domain is an owner decision (it's externally visible).
- **MCP gateway:** adds `list_agents` and `create_task` (scope `link:handoff`, off by default) so ChatGPT and Claude chats can hand work to the owner's agents under the same link rules.
- **"Ask me each time" for outside tasks (M16 F):** an A2A, `create_task` or `/v1/gateway/link-tasks` task over a confirm link is relayed with `linkConfirm` on its `session.start`. The agent makes the `link_handoff` approval (one tap, as in §3), starts the session only on a signed yes, and rejects it on a no or when the TTL passes.
  - The session is named after the task's command id, so the gateway follows it through what it may already read (the approval's status and the session row).
  - The caller sees `TASK_STATE_AUTH_REQUIRED` while waiting, then `WORKING` (delivered) or `REJECTED` (declined or expired), through A2A `GetTask` or MCP `get_task`.
  - We chose `AUTH_REQUIRED` over `INPUT_REQUIRED` because A2A uses INPUT_REQUIRED when the caller must send more, and nothing the caller sends can move this task. Only the owner's authorization can.
- **Catalog growth:** every new tool that speaks ACP, MCP, A2A or a chat API is added as a signed recipe. A tool with none of these is listed as "not connectable" with the reason. **No browser automation of chat websites.**

### 5. Phase E: device to device
- **LAN direct path:**
  - Devices of the same owner discover each other with mDNS (`_chalito._tcp`).
  - They authenticate with their existing device keys plus a cloud-issued, short-lived pairing token.
  - They carry the same sealed envelopes over a local WebSocket. If that fails, they fall back to the cloud path automatically.
- **Screen sharing behind strict NATs:** a TURN relay (ADR 0021 gap). It costs money, so it needs the owner's go.

## Consequences
- Adding an AI is mostly a recipe. Chalito can reach about 25 ACP agents, every OpenAI-compatible provider and any A2A agent, and outside A2A or MCP clients can reach Chalito.
- `docs/THREAT_MODEL.md` gains:
  - Agent-to-agent prompt injection, mitigated by the two modes, quoted results, gated tools and the relayed origin.
  - Hand-off loops, mitigated by hop and chain limits.
  - The A2A server as a new public surface (off by default, OAuth, scoped).
  - LAN spoofing, mitigated by device-key mutual auth.
- Phase A alone should cut terminal-session database writes and improve phone latency, with no client or protocol break.
- A2A is young (v1.0 is from March 2026). We pin the version and run a conformance test against the official SDK fixtures, as with Codex `app-server`.

## Not doing
- Browser automation or scraping of chat websites (owner, 2026-10-15; ground rule).
- Reading the user's own `~/.claude` or `~/.cursor` (peer sessions, agent-bridge). Adapters stay isolated in Chalito's own profiles.
- An invented "Chalito protocol" for third parties. Outside, we speak only A2A, MCP and ACP.

## Delivery
M16 in `docs/PLAN.md`, with one branch and PR per phase (`m16a-efficiency`, `m16b-link-format`, `m16c-links`, `m16d-connect`, `m16e-lan`). We stop for the owner's "go" after each phase.
