# ADR 0024: Shared project memory

- Status: Proposed (M17 docs, 2026-10-16). Nothing is built until the owner's "go".
- Builds on: E2E sealing (ADR 0003), share links and their quoted-data hygiene (ADR 0022 §3), Rooms hygiene (ADR 0010), token efficiency (M9).
- Protocol: `v` stays 1. New schemas `MemoryEntry`, `MemoryProposal`, `MemoryPolicy`; new commands `memory.*`.

## Context
Owner decision (2026-10-16): agents working on the same project should share what they learn, so each new session doesn't start from zero (and doesn't re-read the repo to rediscover it).

Today each agent has its own notes (Claude Code's `CLAUDE.md`, Codex's `AGENTS.md`, Cursor rules), or none. Chalito's Session Card (≤300 tokens) describes one session, not a project. Lessons from running parallel helpers (ADR 0025) are learned again and again: which numbers are taken, how to squash, which tests are slow.

## Decision

### 1. Scope and shape
- One memory **per project**. A project is a repo (by normalized remote URL) or, with no remote, a folder on one device.
- A memory is a list of short `MemoryEntry` items: `id`, `kind` (`fact | convention | decision | gotcha | todo`), `text` (≤ 400 chars), `source` (session, agent, date), `confidence`, `lastUsedAt`, `pinned`.
- Every agent session the owner links to the project can **read** it. Read is a scope on the session, like a connector (ADR 0023): on by default for sessions started in that repo, off for relayed sessions unless the link says so.

### 2. Writes are proposals
- Agents never write memory. They emit a `MemoryProposal` (add, edit, or retire an entry, with a one-line reason), through a local MCP tool `memory.propose` or a marked block in the final message.
- A proposal is applied when either:
  - the owner accepts it (phone or desktop: one tap per proposal, or "accept all from this session"), or
  - a **policy** accepts it: per project, `MemoryPolicy` can auto-accept some kinds from some origins (for example `gotcha` and `convention` from signed-origin sessions). Default policy: **nothing auto-accepted**.
- Relayed-origin sessions (`agent:`, `mcp:`, `call:`, `a2a:`) can propose, but their proposals are never auto-accepted.
- Every accepted or rejected proposal is an audit row (`memory.*`).

### 3. Storage: sealed, like events
- Entries are sealed to the owner's devices and trusted clients (multi-recipient `SealedEnvelope`, ADR 0003) and stored in a new `chalito.memory_entries` table (RLS: owner only), with plaintext metadata limited to project id hash, kind, sizes and timestamps.
- The cloud can't read memory. Agents get it decrypted on the device.
- A local cache lives in `~/.chalito/memory/<project>.json`, signed with the agent key (a file that doesn't verify loads as empty, as with links).
- Export: a plain Markdown file per project, on demand, for the owner to check into the repo if they want (`docs/agent-memory.md` or similar). Never written into the repo automatically.

### 4. Size budget and summarisation
- Budget per project: **2,000 tokens** injected per session (configurable 500 to 8,000 in `packages/config`), 200 entries stored at most.
- Selection when over budget: pinned entries first, then by relevance to the session's goal (cheap embedding or keyword match on the device), then by `lastUsedAt`.
- When the store passes 80% of its cap, Chalito proposes a **compaction**: the router model (M9, `gemini-3.1-flash-lite@global`, or the user's own key) merges duplicates and retires stale entries. The compaction itself is a proposal the owner accepts, and the old entries stay recoverable for 30 days.
- Managed compaction is admitted and settled through the hub (ADR 0016); on BYO keys it costs nothing.

### 5. Injection hygiene: memory is data
- Memory is injected inside a fixed, quoted frame built by Chalito, never by the agent:
  `<project_memory>` … JSON entries, `<`, `>`, `&` escaped … `</project_memory>`, with a preamble saying these are notes, not instructions, and that the owner's prompt and local policy win.
- An entry can't contain tool syntax that the gate would treat differently (the gate never reads memory), and memory can never change permission mode, policy, links or grants.
- Proposals are screened before the owner sees them: entries that look like instructions to future agents ("always run…", "ignore…", URLs to fetch, shell commands) are flagged and can't be auto-accepted by policy.
- Fixtures: a proposal carrying an injection never auto-accepts; injected memory with "push to main" doesn't change the gate's decision.

### 6. Measure the token savings
- Each session logs (in `usage_events`, plaintext counts only): memory tokens injected, and exploration tokens in the first N turns (file reads, searches).
- An A/B switch per project (memory on/off for alternate sessions, owner opt-in) gives the comparison. The comms-overhead page (M9) shows "memory cost vs exploration saved".
- We don't claim savings until the numbers exist (same rule as prompt caching in M9).

## Consequences
- New sessions start with the project's conventions and gotchas, and the coordinator (ADR 0025) can hand helpers the rules once.
- `docs/THREAT_MODEL.md` gains §4.8h: memory poisoning (proposals, owner acceptance, relayed origins never auto-accepted, quoted frame), cross-project leaks (keyed by project, RLS, sealed), and a stale or wrong memory (confidence, retirement, compaction review).
- One more sealed table and a small amount of storage per user.

## Not doing
- Writing into the repo's `CLAUDE.md` / `AGENTS.md` automatically.
- A shared memory across different owners (Teams in ADR 0027 may add one later, with roles).
- Vector databases in the cloud. Retrieval runs on the device.
