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
