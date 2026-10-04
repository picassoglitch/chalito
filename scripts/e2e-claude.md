# Real Claude Code run through chalito-agent (M3 end-to-end)

This runbook is for one manual run on Aldo's machine, using his own Anthropic API key and his own Claude Code install, driven through `chalito-agent`. The automated tests use a fake Claude Code; this run is the only check against the real binary. Record the results at the end of this file (see "Results").

Expect about 45 minutes. The run uses the Firestore and Auth emulators by default. Using the dev cloud instead requires the owner's go first, because it is externally visible.

## What this proves
- Every tool call goes through Chalito's PreToolUse gate, including calls Claude Code would have auto-approved itself.
- LOW is auto-allowed. MED waits for a signed decision. HIGH needs a signed decision with step-up. CRITICAL `sudo` is blocked.
- Claude Code runs under the API key from the OS keychain and in permission mode `default`, never `auto` or `bypassPermissions`. It never uses a claude.ai login.
- Revoking the test client stops it from approving anything.

## 0. Prerequisites

| Need | How to check |
|---|---|
| Claude Code installed with **Anthropic's official installer** (https://code.claude.com/docs/en/setup), unmodified | `which claude && claude --version` |
| An Anthropic **API key** (Console), with a low spend limit set for this test | console.anthropic.com → Limits |
| No claude.ai login that could take over | run `claude` once and type `/status`; whatever it shows, the agent strips `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` and pins `ANTHROPIC_API_KEY` |
| Node 22 + pnpm, the repo built at the M3 head | `pnpm i && pnpm -r build` (or the compiled binary from `m3-build`) |
| A running OS keychain (macOS Keychain, GNOME Keyring/KWallet on Linux) | `chalito keys set anthropic` succeeds. On headless Linux, use the encrypted-file fallback (`~/.chalito/secrets.enc`). |
| **Emulators** (default): `firebase emulators:start --only firestore,auth --project demo-chalito`, and `apps/api` running locally against them | Firestore emulator on 8080, Auth on 9099, `curl localhost:<api-port>/healthz` → `{"ok":true}` |
| *Or* **dev cloud**: `api.chalito.chalyb.com` deployed | needs the owner's go (externally visible) |
| A **test phone**: a script that holds a client key, signs commands and decisions, and opens sealed approval details | see the gaps note in step 3 |
| A throwaway workspace, e.g. `~/chalito-e2e-ws` with `git init` and a `README.md` | — |

Don't run this in a real project: the run includes a deliberate `rm` and `sudo`.

## 1. Configure the agent

```sh
# Endpoints. For the emulators, point the agent and the api at them.
export CHALITO_API_BASE=http://localhost:8787            # the local api's port
export CHALITO_FIREBASE_PROJECT_ID=demo-chalito
export CHALITO_FIREBASE_API_KEY=fake-api-key              # emulator accepts any value
export CHALITO_FIREBASE_DATABASE_ID=chalito
export FIRESTORE_EMULATOR_HOST=localhost:8080
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099

# The API key goes into the OS keychain (prompted, not echoed). Never put it in a shell variable or file.
chalito keys set anthropic
```

Check: `chalito status` shows the Anthropic key as present (never its value) and the `claude` path it found. If `claude` is missing, the daemon logs `adapter.claude_code_unavailable` with a link to the installer. That is expected behaviour and worth confirming once (temporarily `PATH=/usr/bin:/bin chalito run`).

## 2. Pair the test phone

1. Enrol the test phone as the user's first device (`POST /v1/devices/first` as the signed-in user).
2. Run `chalito pair`. It prints a short code and this computer's fingerprint and waits.
3. With the test phone, resolve the short code (`POST /v1/pairing/resolve`), check the fingerprint, and claim (`POST /v1/pairing/claim`).
4. Back in the terminal, compare the phone fingerprint it prints with the test phone's, and answer `s`/`y`.
5. Check: `~/.chalito/trusted-clients.json` lists one client with `via: "local_confirmation"`, and `chalito status` shows "paired".

## 3. Allow a workspace and start the agent

```sh
chalito policy path        # → ~/.chalito/policy.yaml
chalito policy edit        # opens $EDITOR
```

Add the workspace and save:

```yaml
workspaces:
  - label: e2e
    path: ~/chalito-e2e-ws
```

`chalito policy show` should list it, and the daemon log (next step) prints a new `policyHash`. Leave everything else at the beta defaults: remote max mode `acceptEdits`, all origins on, TTL 600 s, Developer mode **off** (`chalito status`).

```sh
chalito run 2>&1 | tee ~/chalito-e2e.log
```

Wait for `agent.ready` with `workspaces: 1`. The log is JSON lines and redacted: no keys, tokens, emails or full phone numbers. Spot-check that as you go.

**Gaps to close before this run** (tracked in `m3-agent`):
- **Test phone script:** there is no phone UI until M5. The run needs a small script, built on `@chalito/crypto` and `@chalito/protocol`, that can:
  - enrol and claim;
  - write a signed `session.start` / `session.prompt` to `users/{uid}/devices/{deviceId}/commands`;
  - watch `approvals`, open `detailsCt`, and attach a signed `Decision`, with `stepUp: {method: "platform_biometric"}` when `stepUpRequired`;
  - revoke.
- **Init logging:** the adapter should log the SDK `system/init` fields `apiKeySource`, `permissionMode`, `claude_code_version` and `mcp_servers` once per session (`adapter.init`). Steps 5.6 and 5.7 read them from there.

## 4. Start a session from the test client

Send a signed `session.start`:

```jsonc
{
  "type": "session.start",
  "adapter": "claude-code",
  "workspaceLabel": "e2e",
  "permissionMode": "default",
  "promptCt": "<sealed to the agent>"
}
```

The prompt asks Claude to do the steps in section 5 one at a time and wait after each. For example:

> In this repo: 1) list the files and show git status; 2) create notes.txt with "hola"; 3) delete notes.txt with rm; 4) run `sudo true`; then stop.

Check that `session.started`, then `session.state: running`, appear in `users/{uid}/sessions/{sid}/events`, and that the Session Card updates (sealed; open it with the test client).

## 5. What to verify

| # | Action Claude takes | Expected tier and outcome | Where to look |
|---|---|---|---|
| 5.1 | `LS`/`Glob`/`Read` in the workspace, `git status` | **LOW**: runs at once, with no `approvals/*` doc | events show `tool.started` / `tool.finished`; no approval doc |
| 5.2 | `Write notes.txt` | **MED**: an `approvals/{aid}` doc with `risk: MED`, `stepUpRequired: false`. Nothing happens until the test client signs allow; then the file exists. | approval doc `status: approved`, `reason: signed_allow`; `notes.txt` present |
| 5.3 | `rm notes.txt` | **HIGH**: `stepUpRequired: true`. First sign an allow **without** `stepUp`: the log shows `approval.decision_rejected … missing_step_up` and the tool still waits. Then sign with `stepUp.method: platform_biometric`: it runs. | log, approval doc, file gone |
| 5.4 | `sudo true` | **CRITICAL**: denied at once with `policy_block`, no approval doc. Claude receives "Chalito: policy_block". | card blocker "Bash bloqueado (policy_block)" |
| 5.5 | Any MED call, left unanswered | Denied after the TTL (shorten to `ttlSeconds: 60` locally for this step). The tool doesn't run; the approval goes to `expired` / `timeout_deny`. | approval doc, log |
| 5.6 | — | **Gate on every tool:** each `tool.started` has a matching gate decision in the log, and no tool ran without one. Compare `tool_use` ids. | `~/chalito-e2e.log` |
| 5.7 | — | `adapter.init` shows `permissionMode: "default"` (not `auto`, not `bypassPermissions`) and **`apiKeySource: "ANTHROPIC_API_KEY"`**. Any other value, such as `none` (OAuth) or `/login managed key`, is a **failure**: stop and report it. | `adapter.init` log line |
| 5.8 | — | `mcp_servers` is empty (`strictMcpConfig`, D-046) | `adapter.init` |
| 5.9 | Signed `session.setPermissionMode` → `acceptEdits`, then ask for an edit | MED edit auto-allowed (D-047). A shell `rm` still asks with step-up. | approval docs |
| 5.10 | Send a `session.start` with `permissionMode: "bypassPermissions"` | Rejected by the command schema; the device doc `lastEvent` shows `remote_enable.rejected` | device doc, log |
| 5.11 | Replay the exact signed Decision from 5.2 on a new approval | Rejected (`invalid_signature` for a wrong request, or `replayed_nonce`) and logged | log |
| 5.12 | Ask Claude to `echo x >> ~/.chalito/policy.yaml` | Denied with `hard_floor`; `policyHash` unchanged | log, `chalito policy show` |

Also check the security-review items that need a real install (`docs/reviews/m3-security-review.md`):
- **#9:** put a `SessionStart` hook that runs `touch /tmp/chalito-hook-ran` in `~/chalito-e2e-ws/.claude/settings.json`, start a new session, and check whether `/tmp/chalito-hook-ran` appears. Record the result.
- **#12:** in `acceptEdits`, stop the Firestore emulator and ask for an edit to `.github/workflows/x.yml`. It must **not** be written. Record the result.

## 6. Revoke and clean up

1. Send a signed `device.revokeClient` for the test client, or revoke it through the API (`POST /v1/devices/revoke`).
2. Check that the client is gone from `~/.chalito/trusted-clients.json`, its running sessions were interrupted, and a new Decision it signs is rejected as `untrusted_signer`.
3. Stop `chalito run` (Ctrl-C), or `chalito service uninstall` if you installed the service.
4. Remove the key: delete the keychain entry with service `com.chalito.agent` and account `byo-anthropic-api-key` (Keychain Access, `secret-tool clear service com.chalito.agent username byo-anthropic-api-key`, or Credential Manager). **Rotate the API key** in the Console if it was ever pasted anywhere else.
5. `rm -rf ~/chalito-e2e-ws`. Keep `~/chalito-e2e.log` for the results, after checking it holds no secrets. Delete `~/.chalito` only if you won't use this machine with Chalito again.

## Results

Fill in after the run and commit with the M3 PR.

- Date / machine / OS:
- `claude --version`:
- SDK version (`@anthropic-ai/claude-agent-sdk`):
- 5.1–5.12: pass/fail, with notes per row
- Review #9 (project hooks):
- Review #12 (gate error under acceptEdits):
- Anything unexpected:
