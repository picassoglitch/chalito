# ADR 0031: Remote control (start anywhere, continue anywhere, move between computers)

- Status: Accepted (owner decisions of 2026-10-21, `SPEC-rc-and-managed.md` §A). Built as stacked PRs (§9).
- Builds on: sessions and the command path (ADR 0004/0008), signed approvals (ADR 0019), hand-off links (ADR 0022 §3, D-070), coordinator G4 (ADR 0025 §6), the live store and drafts (M16 A).
- Protocol: `v` stays 1. New command `session.transfer`; new event `session.transferred`; new link part `chalito.transfer.v1`; new origin `local:cli` (unsigned); new reject reasons `session_busy`, `transfer_dirty`, `transfer_unpushed`; new `RouteRules` and `resolveRoute` (pure, shared by every client).

## Context
Owner, 2026-10-21: "we dont need to see the screen just use a system similar to claude /rc, thats perfect, just like that" and "both, be able to start on pc and continue on phone, also start on phone and tell on what pc to run it and what ai, should be able to transfer it or use rules to know where to run".

What `main` already has:
- Every session mirrors to the hub: sealed `session_events`, live drafts (`message.assistant.delta`), approvals with passkey step-up. Phone prompts, stops and approvals already work for any session.
- `session.start` names the computer (`targetDeviceId`) and the AI (`appId`). The phone can already pick both; only the hub's picker is missing.
- The `local` origin exists (signed, the most trusted turn), but nothing on the computer can start a session: the CLI talks to the daemon only for pairing, and the panel's IPC has no session methods.
- Hand-off links carry typed parts between two of the owner's computers (G4 sends `chalito.coord.task.v1` this way). A link is made only on the sending computer, with OS auth.
- Remote screen and remote terminal are hidden behind build flags (separate PR); this ADR never uses them. No raw shell anywhere.

## Decision

### 1. Start at the computer
- **CLI:** `chalito code <agent> [--workspace <label>] [--mode default|plan|acceptEdits] [prompt…]`. `<agent>` is an app id or a short name (`claude`, `codex`, `gemini`, `grok`). Without `--workspace`, the workspace whose folder contains the current directory; none is an error (Chalito never runs outside a workspace the owner allowed).
  - Interactive like `claude`: assistant text streams (escape sequences and control characters stripped before they reach the terminal), tool steps print as one line (category + summary), `Ctrl-C` stops the turn, a second `Ctrl-C` or `/salir` leaves (the session stays, resumable from the phone).
  - It talks to the running agent over a second local socket, `code.sock` (0600, same directory as `agent.sock`). Not on Windows for now (§6a): there the CLI points to the panel. It serves only the methods below.
- **Desktop panel:** "Nueva sesión" (AI from the ready apps, workspace from the policy, first prompt). The panel uses its existing IPC (`agent.sock`, per-launch secret) for start / prompt / stop, and its live store for the transcript and approvals (it is a trusted client already, so approvals stay signed decisions with passkey).
- Methods: the panel's IPC gets `codeApps`, `codeStart {appId, workspaceLabel, prompt, permissionMode}`, `codePrompt {sid, text}`, `codeStop {sid}`. `code.sock` has `apps`, `workspaceFor {cwd}`, `start`, `prompt`, `stop` and `sessions`, and pushes the plaintext events of the sessions that connection started (kept in memory only; nothing new is stored or sent). A connection steers only its own sessions.
- Origins: the panel's turns are `local` (signed: only the desktop app holds its per-launch IPC secret). `chalito code`'s turns are **`local:cli`, an unsigned origin** (§6a): no Developer-mode auto-approve, no `acceptEdits`, no LOW auto-allow beyond reads, no computer control, no link tools; every other tool asks. It is allowed or refused with `origins.local`. Phone turns stay `client:<id>`. Permission mode at most `policy.remote.maxPermissionMode`; the hard floor and policy blocks still deny.

### 2. Approvals at the computer
- Panel: unchanged (signed decision; HIGH needs the passkey).
- CLI: **answers nothing.** It shows each prompt and says "Apruébala en el panel de Chalito o en tu teléfono". A session's own process can reach `code.sock` (§6a), so an approval answered there could be the session approving itself.
- The first verified answer (panel or phone) wins; the other side sees the approval resolved.

### 3. Start on the phone, choosing the computer and the AI
- Unchanged command: `session.start` with `targetDeviceId` + `appId`. The hub lists the owner's computers (online first; offline ones greyed), the AIs that computer reported ready (`presence.setup.adapters`) and its workspaces (`presence.setup.labels`).
- "Automático" uses the routing rules (§5). The hub resolves the rules and signs a normal `session.start` for the chosen computer; the computer applies its own policy as for any start.

### 4. Transfer a session to another computer
- `session.transfer {sid, toDeviceId}`: signed by a trusted client (phone, panel) and sent to the computer that runs the session; also from the panel locally (`codeTransfer`). Not from `chalito code` (its origin is unsigned). Never relayed (no relay may carry it; `RelayedCommand` already restricts relays to their own payloads).
- On the source computer:
  1. The session must not be busy (`running`, `waiting_approval`, `waiting_input`): `session_busy`. The owner stops it first (one tap).
  2. A hand-off link from this computer to `toDeviceId` that this session may send over (the link pins this session, or names its app, or names none) must exist, else `no_link`. The first such link with "ask me each time" off wins, else the first. The link is what the owner made locally (D-070); its ceiling, rate, budget, hop limits and "ask me each time" apply as for any hand-off.
  3. If the workspace is a git repo: no uncommitted changes, no submodules (`status` can't see inside them) and no repo-local config that runs code (`DANGEROUS_CONFIG`, except the clone's own remote URL); config git can't read counts too (`transfer_dirty`). Only "not a git repository" means conversation only; any other git failure is refused. The branch must be pushed, with `origin/<branch>` as its upstream (`transfer_unpushed`). Chalito only reads git here (hardened runner, `nodeGit`); it never commits or pushes for a transfer.
  4. It sends one hand-off whose only part is `chalito.transfer.v1`: the source sid, the app, a title, a brief (the conversation so far as quoted text, newest last, at most 32 000 characters), and the repo (normalized `origin` URL without credentials, branch, head).
  Each refusal above is also a `session.transferred {stage: "refused"}` event (`busy`, `no_link`, `dirty`, `unpushed`), so the phone shows why.
  5. The session is marked moving: prompts to it are refused (`session_busy`) until the outcome. Event `session.transferred {direction: "out", stage: "sent"}`.
- On the receiving computer (the link manager, like a G4 task):
  - A transfer always makes a new session: it's refused over a link that pins a receiving session (`wrong_endpoint`), and the agent never starts a link session under an id it already has, live or dormant.
  - The repo must match its workspace's `origin` (`wrong_repo`), else refused.
  - The session starts in its own permission mode (carried in the transfer), never above the link's ceiling, with origin `agent:<sourceSid>` in the link's workspace, with the link's app (or the source's app when the link names none), prompted with a fixed frame: the brief as quoted data, then "the work is on branch X at commit Y on origin; fetch and check it out before continuing". The AI's git commands go through the gate (agent origin: every non-read asks the owner).
  - It answers at once with a `link.result` (`TASK_STATE_COMPLETED`, data part `chalito.transfer.ack.v1 {sid}`), and the inbound task is done (later turns send no results). Event `session.transferred {direction: "in", stage: "delivered", peerSid: sourceSid}`.
- Back on the source: on the ack, `session.transferred {direction: "out", stage: "delivered", peerSid}` and the session closes (it stays resumable here). On a refusal or no answer within the relay TTL plus one minute: `stage: "refused"` with the reason, the moving mark is cleared and the session keeps working here.
- The hub follows a transfer by `peerSid` (or by the new session's `agent:<sourceSid>` origin).

### 5. Routing rules (where a new session runs when the owner doesn't pick)
- `RouteRules {v: 1, rules: RouteRule[≤8], fallback: DeviceId[≤6]}`; `RouteRule {workspaceLabel?, appId?, devices: DeviceId[1..3]}`.
- `resolveRoute(rules, want {workspaceLabel?, appId?}, computers)`:
  1. Rules in order. A rule applies when each field it sets equals the request's, or the request leaves it open (then the rule fills it: "chalito → Codex on the home PC").
  2. In an applying rule, the first of its computers that is online and able (has the app ready and the workspace) wins. None able: the next rule.
  3. Then the fallback order, then any other online computer that is able, in the order given.
  4. Nothing able: `no_computer` (offline or missing the app or workspace); the hub asks the owner to pick.
- Stored in the owner's settings (`chalito.users.prefs.routing`, via `update_my_settings`; at most 3 000 bytes), so **no migration**. Not the coordinator's rules table: those rows are signed remembered approvals that agents verify and use to answer prompts; a routing rule answers nothing and grants nothing.
- Integrity: a routing rule can only choose among the owner's own computers, and the chosen computer still applies its policy, workspace list and gates. A server that rewrote the rules could pick a different one of the owner's computers, nothing more. Agents never read the rules.

### 6. Who can start what where
| Action | From | Needs |
|---|---|---|
| Start, prompt, stop | Phone / hub | A trusted client's signed command (unchanged) |
| Start, prompt, stop | Panel | Its per-launch IPC secret; origin `local` |
| Start, prompt, stop | `chalito code` | Same user on that computer (any process of it); origin `local:cli`, unsigned |
| Approve MED | Phone, panel | Signed decision |
| Approve anything | `chalito code` | Never |
| Approve HIGH | Phone, panel | Signed decision + passkey |
| Transfer | Phone, panel | Session idle, a hand-off link made locally on the source, clean pushed git |
| Routing rules | Hub (owner's session) | Chooses only among the owner's computers |

### 6a. Why `code.sock` gets no trust (security review, 2026-10-21)
- **Any process of the user can connect**, including a coding agent inside a Chalito session (a Python one-liner, not the `chalito` binary the classifier blocks). A per-launch token in a 0600 file doesn't stop it: the session runs as the same user, and a script it was allowed to run can read the file. Peer-credential checks (`SO_PEERCRED`, `getpeereid`) plus "refuse descendants of a session" don't either: Node can't read the peer's pid portably, and a process that double-forks (`setsid`) is reparented away from the session. So the design assumes the caller may be a session and gives it nothing a session doesn't already have:
  - **No origin laundering:** its sessions are `local:cli`, unsigned, so a session that starts one gets a session gated like its own turns (every non-read asks). The panel keeps `local`; its secret lives only in the desktop app's memory.
  - **No self-approval:** `code.sock` has no `decide`. Approvals are answered on the panel or the phone (signed, passkey for HIGH).
  - **No reach into other sessions:** a connection sees and steers only the sessions it started; it can't read or stop any other.
  - **No crowding out:** `local:cli` sessions have their own live cap (2) and only ever evict each other, never the owner's other sessions; at most 3 starts per connection and 6 per minute; at most 20 of their records in `sessions.json`, after everything else.
  - **No escalation by mode:** a `local:cli` start can't pick `acceptEdits` (it would carry over to the owner's later signed turns).
  - **Bounded:** a reader that falls 1 MB behind is dropped; events from before a start's id is known are kept up to 500.
  - Every command typed at the computer gets an audit row (`command.accepted` / `command.rejected`) with its origin; a session started there shows its first prompt on the phone like any turn.
- **Windows:** Node can't create a named pipe with an explicit DACL or `FILE_FLAG_FIRST_PIPE_INSTANCE`, so another user's process could squat `\\.\pipe\chalito-code-<user>` and read what the CLI sends. Until a native pipe with a current-user-only DACL and a server-owner check exists, the agent doesn't serve `code.sock` on Windows and the CLI says to use the panel.
- Owner option (§8): give `chalito code` signed trust after an OS password prompt per start (human presence), still with no `decide`.

Nothing here can turn on remote screen, remote terminal, the raw shell, Developer mode or computer control, or raise a permission mode above the ceiling.

### 7. Failure cases
- **Target offline at start:** the hub marks it offline and "Automático" skips it; a command to an offline computer expires after 10 minutes (`expired`), and the hub says it didn't answer.
- **Receiver offline mid-transfer:** the relay expires after 5 minutes; the source reports `refused {reason: "offline"}` one minute later and the session stays where it was, usable. Nothing was moved or deleted, so there is nothing to undo.
- **The owner says yes late** (an "ask me each time" link, after the source gave up): the receiver starts and acks; the source then reports `delivered` and closes its copy only if no new turn happened there since it gave up and it isn't busy (otherwise both stay). An ack for a session that got busy here doesn't close it either.
- **Source goes offline after sending:** the receiver still starts and acks; the source learns it on reconnect (the ack waits in its command queue for the relay TTL) or reports `offline` and keeps its copy. Two live copies are possible in that window; the hub shows both, each with its computer.
- **Both sides typing:** prompts are queued in arrival order (as today); each shows with its origin (computer or phone). A prompt sent into a running turn lowers that turn's origin to the less trusted one. Stop from either side stops the turn for both.
- **Both sides approving:** the first verified answer wins; the second sees the approval resolved.
- **Panel closed:** `chalito code` keeps working (approvals then go to the phone) (the daemon serves `code.sock` with or without the desktop app).
- **Agent restarts:** sessions resume from the phone as today (M16 A). The CLI loses its connection; a new `chalito code` can't re-attach to the old session (continue it from the phone or the panel).

## Consequences
- The PC and the phone are two views of one session, like Claude Code's /rc. No screen or shell travels.
- `docs/THREAT_MODEL.md` gains §4.8j: `code.sock` as a same-user surface (§6a), and transfer as a hand-off (link-gated, quoted brief, agent origin on the receiver).

## Not doing
- Moving uncommitted work automatically (a WIP commit or push). Owner decision pending (§8).
- Continuing a native Claude Code or Codex session started outside Chalito (owner: later).
- Routing evaluated on the computers, or rules that can refuse a start.

## 8. Open for the owner
- Transfer with uncommitted work: today refused (`transfer_dirty`). Option: push a snapshot to `chalito/transfer/<sid>` (owner's tap) and check it out on the receiver.
- Whether `chalito code` sessions should become `local` (signed) after an OS password prompt at each start (today: `local:cli`, unsigned), and a native Windows pipe with a current-user DACL so the CLI works there.

## 9. Delivery
Rollout: clients drop events their protocol copy doesn't parse, so the hub's vendored protocol (f) and the web app ship before any agent runs (b) or (d); until then an older phone doesn't show `local:cli` sessions' turns or `session.transferred`.

One PR each, stacked: (a) this ADR + protocol; (b) agent local sessions, `code.sock`, `chalito code`; (c) panel "Nueva sesión"; (d) transfer; (e) routing rules in the client; (f) hub (chalyb): computer + AI picker, "Automático", transfer button, rules screen.
