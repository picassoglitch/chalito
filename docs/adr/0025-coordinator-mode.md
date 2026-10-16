# ADR 0025: Coordinator mode (one goal, several agents in parallel worktrees)

- Status: Proposed (M17 docs, 2026-10-16). Nothing is built until the owner's "go".
- Builds on: hand-off links (ADR 0022 §3), the `LinkTask` format (ADR 0022 §2), connectors (ADR 0023, for GitHub), shared project memory (ADR 0024), budgets and hub admit/settle (ADR 0016), revoke-all (ADR 0020).
- Protocol: `v` stays 1. New schemas `CoordPlan`, `CoordTask`, `CoordLedger`; new commands `coord.*`.

## Context
Owner decision (2026-10-16): Chalito should be able to take one goal, split it, and run several agents at once, the way the owner already runs Chalito's own milestones by hand (one coordinator, helpers on branches, a reviewer, then a merge).

Lessons from doing that by hand (M14 to M16):
1. **Numbers collide.** Two helpers on different branches both took the next migration, pgTAP and deviation number. Cross-branch checks miss numbers that exist only in a local worktree. Numbers must be handed out by the coordinator.
2. **Squashing onto a moved ref loses or resurrects work.** Squash only with `git reset --soft $(git merge-base HEAD <base>)`, never onto a remote ref that moved after the branch started.
3. **Diffs hide deletions.** A rebase or squash silently dropped files more than once. Every PR's diff must be checked for deleted files and large removed hunks before review.
4. **Integration merges are their own job.** Merging several helper branches into an integration branch produces conflicts and broken tests that belong to no one helper. It needs a dedicated step with its own tests.
5. The coordinator works best when it **doesn't write code**: it assigns, unblocks, reviews and keeps helpers moving.

## Decision

### 1. Flow
| Step | Who | What |
|---|---|---|
| 1. Goal | Owner | A goal, a repo, a base branch, a budget, and how many agents at most (default 3, max 6). |
| 2. Plan | Coordinator session | Splits the goal into `CoordTask`s: title, acceptance criteria, files it expects to touch, dependencies, which agent recipe. The plan is shown to the owner; **one tap to start** (or edit). |
| 3. Run | Helpers | Each task runs in its **own git worktree** (`<repo>-wt/<task>`) on its own branch `coord/<plan>/<task>`, through a hand-off link that the coordinator mode creates locally for this plan only (expires with the plan). |
| 4. Track | Coordinator | Reads `LinkTask` status, answers helper questions it can (from memory and the plan), escalates the rest to the owner. Shows progress on the phone. |
| 5. PRs | Helpers | Each helper pushes and opens a PR (GitHub connector, write tier for that repo only) into the plan's integration branch. |
| 6. Review | Reviewer agent | A separate session (ideally another vendor's model) reviews each PR against its AC, with read-only connectors. Findings go back to the helper as a hand-off. |
| 7. Integrate | Integration step | A dedicated task merges the helper PRs into `coord/<plan>/integration` in dependency order, runs the full test suite, fixes conflicts only (no new features). |
| 8. Merge | Owner | **One tap** on the phone: merge the integration PR into the base. Chalito never merges to the base by itself. |

### 2. The ledger: central numbering and rules
- The coordinator keeps a `CoordLedger` per repo (sealed, stored with the plan, cached locally):
  - reserved **migration numbers, pgTAP numbers, deviation (D-) numbers, ADR numbers**, and any other sequence the repo declares in `.chalito/sequences.yaml` (pattern + where to look);
  - which task holds each one.
- A helper gets its numbers in its task brief and asks the coordinator (`coord.reserve`) for more. The ledger scans the base, every open branch **and every local worktree** before reserving.
- The repo's rules from ADR 0024 memory are given to every helper in the brief (squash only onto the merge-base, check diffs for deletions, author identity, no AI attribution if the repo says so).

### 3. Checks the coordinator runs, not the helpers
- **Before review:** `git diff --diff-filter=D --name-only <merge-base>..HEAD` and a removed-lines report. Any deleted file not named in the task is a blocking finding.
- **Squash:** only `git reset --soft $(git merge-base HEAD <base>)` then one commit. A helper that rebased onto a moved ref is asked to redo it.
- **Numbers:** every new migration/pgTAP/D-/ADR file in a PR must match a ledger reservation for that task.
- **Integration:** the integration step's own CI run must be green before the owner's merge tap appears.

### 4. Budgets and the kill switch
- **Budget per plan:** tokens (through hub admit/settle for managed models; counted for BYO), wall-clock time and number of agents. Each helper gets a share; going over pauses that helper and asks the owner.
- **Kill switch:** one button on the phone and desktop (`coord.stop`) that interrupts every helper, reviewer and the coordinator, revokes the plan's links, and keeps the worktrees and branches for inspection. Revoke-all (ADR 0020) also stops every plan.
- Helpers run at most `remote.maxPermissionMode`, never with Developer-mode auto-approve (they are `agent:` origin). Every MED+ tool still asks the phone, so the owner can choose "approve all `git` and test commands for this plan" as a time-boxed plan rule (local policy ceiling still applies).

### 5. Owner view
- One card per plan: tasks, status, PR links, budget used, open questions, findings, and the merge button.
- Notifications use the escalation ladder; a finished plan is an L2 push, a blocked one L3.

## Consequences
- The owner's manual coordinator routine becomes a product feature, with the mistakes that burned time made impossible by design (ledger, merge-base squash, deletion check, integration step).
- Costs scale with the number of agents. Budgets and the default of 3 keep that visible.
- `docs/THREAT_MODEL.md` gains §4.8i: a helper escaping its worktree (cwd pinned, the same hard floor as sessions), runaway spend (budgets, kill switch), and a reviewer approving a malicious change (the owner's merge tap stays required).

## Not doing
- Merging into the base branch without the owner's tap.
- Running helpers on the cloud. They run on the owner's devices (any of them, across devices through links).
- Supporting git hosts other than GitHub in the first phase (GitLab later, through its official MCP server or API).
