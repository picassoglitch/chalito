# ADR 0027: Useful extras from similar tools

- Status: Proposed (M17 docs, 2026-10-16). Nothing is built until the owner's "go".
- Builds on: ADR 0022 (links), ADR 0023 (connectors), ADR 0024 (memory), ADR 0025 (coordinator), M9 (`usage_events`), M12 (entitlements).

## Context
Owner decision (2026-10-16): add the features that proved useful in similar products. We looked at what Claude Code, Cursor, Devin, Codex cloud, the GitHub Copilot coding agent and Zapier/n8n ship and people keep using, and kept five. Each fits Chalito's model: agents run on the user's devices, the phone approves.

| Feature | Where it's proven |
|---|---|
| Checkpoints and undo | Claude Code checkpoints (`/rewind`), Cursor checkpoints |
| Scheduled runs (routines) | Claude Code scheduled agents, Codex cloud tasks, Zapier/n8n triggers |
| Task templates / skills | Claude Code skills and slash commands, Devin playbooks, n8n templates |
| Model and agent routing | Cursor "auto" model, OpenRouter-style routing |
| Teams | Devin and Copilot agent org seats, Cursor teams, n8n projects with roles |

## Decision: the five, ranked by value

### 1. Checkpoints and undo of agent edits
- **What:** before each turn that may write files, the agent snapshots the session's worktree (a hidden git ref `refs/chalito/cp/<sid>/<n>` built from the index and working tree with `git stash create`-style plumbing, never touching the user's stash or branches; non-git folders get a copy-on-write file list). The phone and desktop show "undo to before this turn" per turn.
- Undo restores files only. It never rewrites history the user pushed, and it warns when a turn ran commands with outside effects (network, `git push`, connector writes), which can't be undone.
- Checkpoints expire after 7 days or 50 per session.
- **Value:** high. It makes "approve" cheaper to say, because mistakes are reversible.
- **Effort:** S–M (agent-side only; one new command `session.undo`, signed like any command).
- **Risk:** low. Large repos (snapshot time: use git's object store, skip ignored files); binary files (size cap).

### 2. Task templates and a skills library
- **What:** a template is a named goal with fixed parts: prompt, agent recipe, working directory, connectors and tiers (ADR 0023), memory scope, budget, permission ceiling, and approval rules (e.g. "allow `pnpm test` for this task"). Templates live in `~/.chalito/templates/` (signed) and can be shared as a file.
- A "skill" is a template plus reference files the agent can read (like Claude Code skills). Chalito passes them in through the adapter's official mechanism (a project `CLAUDE.md`-style append, ACP context), never by editing the user's own config.
- Starting a template from the phone is one tap; its rules can't exceed local policy.
- **Value:** high. It is the base for routines and the coordinator's task briefs.
- **Effort:** M.
- **Risk:** low–medium. A shared template could carry a hostile prompt: imported templates are shown in full and marked unverified until the owner accepts them, and never carry looser approval rules than the importer's policy.

### 3. Scheduled and recurring runs (routines)
- **What:** run a template on a schedule (cron in the user's time zone) or on an event (a GitHub issue labelled, a PR opened, a Linear issue assigned, via the connector's webhook or a poll the vendor allows).
- Runs happen on a chosen device that's online. If it's offline at the time, the run waits up to a window (default 2 h) and then is skipped with a notice. No cloud execution.
- Each run has the template's budget, and approvals still go to the phone. A routine whose approvals time out stops (the ladder doesn't call the owner at 3 a.m. for a routine unless the template says so).
- **Value:** high (nightly dependency updates, triage, reports).
- **Effort:** M (scheduler in the agent, a cloud-side reminder through the existing Cloud Tasks/notifier for the "device offline" notice).
- **Risk:** medium. Runaway cost (budget per run and per day, kill switch from ADR 0025); unattended writes (default ceiling `read` for routines, write needs an explicit template rule).

### 4. Automatic model and agent routing by cost and quality
- **What:** for a task without a fixed agent, Chalito **suggests** the agent and model and the owner **confirms with one tap** (owner, 2026-10-16, decision #47; no automatic pick), from the user's own `usage_events` and outcomes: tokens and cost per task kind, success (tests pass, PR merged, no undo), time.
- Always a suggestion with its reason; the one-tap confirm can change the pick. It starts with a simple rule table in `models.yaml` (kind → candidates); it learns per user once there are 20+ finished tasks of a kind. Only models the user has keys or plan access for are candidates.
- **Value:** medium–high (costs are the main complaint with agents).
- **Effort:** M (data is already in `usage_events`; needs outcome signals and a small scorer).
- **Risk:** medium. Bad picks on thin data (always suggest-and-confirm, show the reason); vendor terms (we never route a request through a plan login we don't hold; Claude Code stays on API keys, D-002).

### 5. Teams: sharing agents and approvals with roles
- **What:** an owner invites people (Chalyb accounts) to a team. Roles:

| Role | Can |
|---|---|
| Owner | everything, including policy ceilings and billing |
| Approver | approve or deny items on shared agents, up to a risk level the owner sets |
| Member | start sessions and templates on shared agents, see their own sessions |
| Viewer | see status and cards, no prompts |

- A shared agent stays on the owner's device; team members' clients become trusted clients **for that agent only**, added locally on the device (like any trusted client, ADR 0006). Sealing adds their keys as recipients for shared sessions.
- Billing follows the hub: Chalyb would need team seats or a shared balance (a Chalyb-side change, the owner's go).
- **Value:** medium now, high for growth.
- **Effort:** L (roles in rules/RLS, sealing to more recipients, invites, hub changes).
- **Risk:** high. A wider attack surface (step-up on every role change, revoke-all per member), and the hub work. Last in the order.

## Considered and left out
- Cloud sandboxes (Devin, Codex cloud): against "the device is the root of trust" and costs money per minute. Maybe later as an opt-in recipe.
- Visual workflow builder (n8n/Zapier): templates and routines cover the agent case; a builder is a product of its own.
- Browser agents that drive websites: ground rule, not doing.

## Consequences
- Templates come first, because routines, the coordinator and teams all reuse them.
- Each feature is one PR in M17 (see `docs/PLAN.md`), each behind a feature flag in `packages/config`, default off until the owner turns it on.
