# ADR 0008: Local policy file and Developer mode

- Status: Accepted (M0); implemented in `apps/agent/src/{policy,devmode,origins}` (M3)

## Policy file is the ceiling
- `~/.chalito/policy.yaml` is owned by the user. It is never writable by agent sessions (a hard floor, even with `autoApproveCritical`). Its hash `policyHash` (SHA-256 of the canonical form) is reported to the cloud and written to the audit log on every change.
- **Tightening** can come from any trusted client (signed `policy.tighten`). The agent applies a patch only if the resulting policy is a **subset** of the current one.
- **Loosening** happens only by editing locally plus confirming locally in the desktop app or CLI.
- **Cloud presets** (Estricto / Estándar / Relajado) are proposals. They apply only after acceptance on the device.

### Beta defaults
- Workspaces: none until the user picks folders. With no workspaces, nothing runs.
- Adapters: claude-code and codex on.
- Remote max mode: Claude `acceptEdits`, Codex `workspace-write`. `bypassPermissions`, `dontAsk` and `auto` are **unrepresentable remotely** (`RemotePermissionMode` in protocol), and so is Codex `danger-full-access`.
- Origins `local`, `client:*`, `mcp:*`, `call:*` are allowed by default. Each can be turned off.
- Approvals: TTL 10 min, timeout = deny.
- Plaintext egress: none, except opt-in callLines and MCP card sharing.

### Tiers
| Tier | Examples | Handling |
|---|---|---|
| LOW | Read/Glob/Grep, `git status/diff/log`, allowlisted test/lint/build, inside allowed folders | auto-approved |
| MED | edits/creates in folder, commands confined to folder, package installs, web fetch to a new domain | one tap (signed) |
| HIGH | `git push`, deletes, config/CI/`.env`, anything outside allowed folders, tools writing to external services | tap + WebAuthn/biometric step-up (signed) |
| CRITICAL | `sudo`, reading `~/.ssh` / cloud creds / keychain, force-push to `main`, `curl … \| sh`, editing `~/.chalito` | blocked |

### Enforcement point
- **Every tool call goes through a `PreToolUse` hook** with no matcher. It runs before deny/ask rules and permission modes, and it runs even under bypass (verified 2026-10-03).
- `canUseTool` alone is not enough: it never fires for auto-approved calls.
- The hook classifies the call and returns `deny`, `allow` (LOW / Developer-mode cases) or waits for a signed Decision.
- **The hook timeout must exceed the 10-min approval TTL** (default is 600 s, and a timeout means the tool doesn't run). Set `timeout: 660`, or use `defer` + resume for long waits.
- Codex: the same classifier runs on `codex app-server` approval requests.

## Developer mode
- **Off by default.** It can be enabled only **locally** (desktop app or `chalito devmode on`) with OS user authentication:
  - macOS: LocalAuthentication.
  - Windows: Windows Hello / credential prompt.
  - Linux: polkit `pkcheck`, or re-entering the user password via PAM helper.
- Individual toggles: `allowSudo`, `autoApproveHigh`, `autoApproveCritical`, later `bypassStyle`. Each needs **three separate confirmations**:
  1. "¿Activar {toggle}?" with concrete failure examples.
  2. A restated risk, e.g. "sudo puede dañar tu sistema de forma irreversible".
  3. Liability acceptance: checkbox + typed phrase, text from `packages/config/legal/devmode-liability.{es,en}.md`, versioned to match the ToS clause.
- Record = text + version + timestamp + device + toggle → audit log + `~/.chalito/audit/` (append-only, hash-chained).
- Cancelling at any step leaves the toggle off and writes no acceptance.
- **Off from anywhere:** any trusted client sends a signed `devmode.off` / `devmode.toggleOff`. It applies immediately. Phone, web, cloud, MCP, call and room surfaces have **no command that turns anything on** (schema-level), and attempts are audit-logged as `remote_enable.rejected`.
- **Hard floors that Developer mode can't lift:**
  - Sessions never edit `~/.chalito`.
  - Auto-approve never applies to turns from `mcp:*` or `call:*` or any unsigned path. Rooms can never originate turns at all.
- A badge "Modo desarrollador ACTIVO" shows on all clients and on the companion.

## As built (M3)

This section reflects `m3-agent` at d9eb89b. The shell classifier is being hardened on `m3-classify` (security review `docs/reviews/m3-security-review.md`, findings 2–8). Where this section disagrees with the decisions above, this section describes the code.

### Policy file (`apps/agent/src/policy/schema.ts`, `hash.ts`, `tighten.ts`)
- `Policy` (zod, `version: 1`) has these sections:

  | Section | Contents |
  |---|---|
  | `workspaces` | `{label, path}[]`, default empty |
  | `adapters` | `{claudeCode, codex}` |
  | `remote` | `{maxPermissionMode, maxCodexSandbox}` |
  | `origins` | `{local, client, mcp, call}` |
  | `approvals` | `{ttlSeconds}`, 30–600 |
  | `egress` | `{callLines, mcpCards}` |
  | `allowlist` | `{commands}` |
  | `web` | `{allowDomains}` |
  | `mcp` | `{readOnlyTools}` |

- `DEFAULT_POLICY` is the brief's beta default: no workspaces, both adapters on, `acceptEdits` / `workspace-write`, all origins on, TTL 600 s, `callLines` on and `mcpCards` off, plus about 25 allowlisted test/lint/build commands.
- `policyHash` = SHA-256 of the JCS canonical JSON of the parsed policy (D-040).
- **Tighten:** `applyRemoteTighten` merges a remote patch shallowly per section, re-validates it, and applies it only if `isTighterOrEqual(next, cur)` holds:
  - every workspace is within a current one;
  - flags only turn off;
  - mode, sandbox and TTL are no higher;
  - allowlist, domains and read-only MCP tools are subsets.

  Otherwise the result is `would_loosen`.
- **Presets:** `presetPolicy` changes only `remote`, `origins` and `egress`. `policy.proposePreset` only stores `pendingPreset`; `acceptPendingPreset()` applies it after local acceptance (CLI or desktop).
- **File handling (`m3-cli`, `src/policy-file.ts`):** `FilePolicyHolder` writes `policy.yaml` atomically (0600) and watches the directory for local edits. A change triggers a re-hash, `devices/{id}.policyHash`, and a `policy.changed` DeviceEvent (D-043).

### Classification (`policy/classify.ts`)
- `classifyToolCall(tool, input, {policy, home, cwd})` returns:
  - `tier`;
  - `category`;
  - `reasons`;
  - `hardFloor`: touches `~/.chalito`;
  - `sudo`;
  - `workspaceEdit`: a MED Edit/Write inside a workspace;
  - `noWorkspace`: no workspaces, or the session cwd is outside them, which makes the call CRITICAL and denied.
- **Paths:**
  - `~` is expanded, then symlinks are resolved through the nearest existing ancestor (`defaultRealpath`) before any check.
  - Order of checks: `~/.chalito` is the hard floor; credentials paths are CRITICAL (`.ssh`, `.aws`, `.config/gcloud`, `.kube`, `.gnupg`, `.docker`, keyrings, `.codex`, `.netrc`/`.npmrc`/`.git-credentials`, Claude credentials, `/etc/shadow`, sudoers); anything outside the workspaces is HIGH; writes to config/CI are HIGH (`.env*`, `.github`, `.circleci`, `.buildkite`, CI files, `.git/hooks`, `.git/config`, `.claude/settings*.json`, `.husky`); reads are LOW and writes MED.
- **Tools:**

  | Tool | Tier |
  |---|---|
  | Read / Glob / Grep / LS / NotebookRead | path rules (read) |
  | Edit / MultiEdit / Write / NotebookEdit | path rules (write); HIGH without a path |
  | WebFetch | LOW for `web.allowDomains` and their subdomains, MED for a new domain, HIGH for a bad URL |
  | WebSearch | MED |
  | TodoWrite, Task/Agent, plan-mode tools, AskUserQuestion | LOW |
  | `mcp__*` | HIGH unless listed in `mcp.readOnlyTools` |
  | unknown tools | HIGH |

- **Bash:**
  - A small POSIX tokenizer (quotes, escapes, `; && || | &`, newlines, `>`/`>>` redirects) splits the command into segments. An unparseable command is HIGH. Substitutions with `$(…)` and backticks are classified recursively and are at least MED.
  - Wrappers (`env`, `nohup`, `exec`, `command`, `time`, `nice`, `timeout`, `xargs`, …) and `bash -c` / `eval` are unwrapped.
  - Each segment is ranked:
    - CRITICAL: `sudo`/`doas`/`su`/`pkexec`, `curl|wget` piped into a shell, keychain CLIs, disk tools;
    - every path-like argument goes through the path rules;
    - `git push` is HIGH, a force-push to `main`/`master` or with an unspecified ref is CRITICAL, `git status`/`diff`/`log`/`show`/… are LOW, discarding work is HIGH, other git commands MED;
    - deleters are HIGH;
    - external-service CLIs (`gcloud`, `aws`, `kubectl`, `terraform`, `docker`, `ssh`, `gh`, …) are HIGH;
    - package installs and network fetches are MED;
    - allowlisted and read-only commands are LOW;
    - anything else is MED.
  - Known gaps and their fixes are in the security review.

### Decision (`policy/decide.ts`)
The checks run in this order:

1. No workspace: deny.
2. Hard floor: deny, whatever Developer mode says.
3. Origin turned off in the policy: deny.
4. `plan` mode: deny anything above LOW.

Then by tier:

| Tier | Result |
|---|---|
| LOW | allow |
| MED | ask without step-up; Edit/Write workspace edits are allowed in `acceptEdits` (D-047) |
| HIGH | ask with step-up, or allow with `autoApproveHigh` |
| CRITICAL, sudo | deny unless `allowSudo`; then ask with step-up, or allow if `autoApproveCritical` is also on (D-042) |
| CRITICAL, other | deny unless `autoApproveCritical` |

Developer-mode toggles count only when the turn's origin is signed (`local` or `client:*`, `isSignedOrigin`). They never count for `mcp:*` or `call:*` turns.

### Enforcement (`agent-core.ts`, `approvals.ts`)
- Every PreToolUse call is classified and decided against the **current** policy and Developer-mode state, which are re-read on each call.
- An `ask` creates `approvals/{aid}`:
  - risk, step-up flag, origin and expiry in plaintext;
  - details (tool, input, reasons) sealed to the clients this device trusts (`Sealer`, AAD `approval:<aid>`).
- It then waits for a `decision` on that doc. A decision counts only if all of these hold:
  - it verifies against the **local** trusted list with context `chalito.decision.v1`;
  - it matches `aid`, `requestId` and this device;
  - it hasn't expired and its nonce is unused;
  - for step-up approvals, it carries `stepUp.method` = `webauthn` or `platform_biometric` (D-039).
- Anything else is logged and the wait continues. The timer (policy TTL, at most 600 s) ends in `timeout_deny`. With no trusted clients, the result is an immediate deny.

### Commands and origins (`agent-core.ts`, `packages/protocol/src/command.ts`)
- **Signed commands:**
  - verified against the local trusted list (`chalito.command.v1`);
  - `origin` must equal `client:<signer>`;
  - target device, owner, expiry (60 s of skew) and a single-use nonce are checked;
  - then the origin policy applies.
- **Relayed commands** (`relayedBy: mcp-gateway | notifier`): the schema allows only `session.prompt` and `session.answer` from `mcp:*` or `call:*` origins (security review #10–11 cover the gaps).
- `session.start` and `session.setPermissionMode` above `remote.maxPermissionMode` are rejected.
- There is no command shape that enables Developer mode or loosens policy. An invalid command whose type or mode looks like an enable attempt (`devmode.on`, `bypassPermissions`, `dontAsk`, `auto`, `danger-full-access`, …) emits a `remote_enable.rejected` DeviceEvent and an audit line.
- A signed `devmode.off` / `devmode.toggleOff` applies at once. `device.revokeClient` removes the key from the local list, re-signs the list, and interrupts that client's sessions.

### Developer mode (`devmode.ts`; OS auth and prompts in `m3-cli`)
- `enableToggle` requires, in order:
  1. OS auth (D-038);
  2. confirmation 1, with the examples from `RISK_COPY`;
  3. confirmation 2, restating the risk;
  4. the liability step: a checkbox plus typing the phrase from `packages/config/legal/devmode-liability.{es,en}.md` exactly.
- Cancelling at any step returns `cancelled` and writes nothing.
- On success it appends a hash-chained record to `~/.chalito/audit/devmode.jsonl`, updates `~/.chalito/devmode.json`, and emits `devmode.liability_accepted` and `devmode.changed` (D-041).
- The daemon never turns anything on. Its OS-auth and prompter stubs always refuse, so only `chalito devmode on` on a TTY can.
- **Known gap:** `devmode.json` and the audit chain are not signed yet (security review #1, #15).
