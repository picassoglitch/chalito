# Real Claude Code run through chalito-agent (M3 end-to-end)

This runbook is for one manual run on Aldo's machine, using his own Anthropic API key and his own Claude Code install, driven through `chalito-agent`. The automated tests use a fake Claude Code; this run is the only check against the real binary. Record the results at the end of this file (see "Results").

Expect about 45 minutes. The run uses the local Supabase stack (`supabase start`) by default. Using the dev cloud instead requires the owner's go first, because it is externally visible.

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
| A running OS keychain (macOS Keychain, GNOME Keyring/KWallet on Linux) | `chalito keys set anthropic` succeeds. Without a reachable keychain (headless Linux) the agent falls back to the passphrase-encrypted `~/.chalito/secrets.enc` and warns. |
| A **real terminal** you type in | `pair`, `keys`, `claude pin`, `policy edit`, `devmode` and `service` refuse piped stdin and refuse to run inside an agent session (`CHALITO_SESSION` set). Run them yourself, not through a script or an AI tool. |
| **Local Supabase stack** (default): Docker + the Supabase CLI, then `supabase start` in the repo (applies `supabase/migrations`), plus `apps/api` running locally against it (step 1) | `supabase status` shows API on 54321; `curl localhost:8787/healthz` → `{"ok":true}` |
| *Or* **dev cloud**: `api.chalito.chalyb.com` deployed | needs the owner's go (externally visible) |
| The **test phone**: `scripts/e2e-phone.ts`, which holds a test client key in `~/.chalito-e2e-phone.json`, signs commands and decisions, and opens sealed details | `pnpm tsx scripts/e2e-phone.ts help` |
| A throwaway workspace, e.g. `~/chalito-e2e-ws` with `git init` and a `README.md` | — |

Don't run this in a real project: the run includes a deliberate `rm` and `sudo`.

**Keeping the run isolated (optional, recommended).** To leave your real `~/.chalito` and OS keychain untouched, run every `chalito` command of this runbook with a scratch home and an encrypted secrets file:

```sh
export HOME=$(mktemp -d)                                  # scratch ~/.chalito
export CHALITO_SECRETS=file:$HOME/secrets.enc             # dev/test only: keys in an encrypted file, not the keychain
export CHALITO_SECRETS_PASSPHRASE='<a throwaway passphrase>'
```

The CLI prints a warning when `CHALITO_SECRETS` is in use. Never set it on a real install.

## 1. Start the api and configure the agent

Put this in every terminal you use (api, agent, test phone):

```sh
# Endpoints: the local Supabase stack, for the agent, the api and the test phone.
eval "$(supabase status -o env)"                          # API_URL, DB_URL, ANON/PUBLISHABLE and SERVICE_ROLE keys (local only)
export CHALITO_API_BASE=http://localhost:8787            # the local api
export SUPABASE_URL=$API_URL
export SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY:-$ANON_KEY}
export CHALITO_SSO_SECRET=local-e2e-sso-secret            # shared by the api and the test phone (enrol)
```

The hub user you'll act as is a Supabase Auth user of the (local) hub project. Create one and keep its id for step 2:

```sh
HUB_UID=$(curl -s -X POST "$API_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "content-type: application/json" \
  -d '{"email":"aldo-e2e@example.invalid","email_confirm":true}' | jq -r .id)
echo "$HUB_UID"
```

Start the api against the stack. It listens on 8787 by default. Off Cloud Run, audit records go to its stdout; they go to Pub/Sub only if you also run the Pub/Sub emulator and set `PUBSUB_EMULATOR_HOST`, which is optional here.

```sh
DATABASE_URL=$DB_URL DATABASE_ROLE=chalito_server SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY \
  CHALITO_ADMIN_TOKEN=local-e2e-admin pnpm --filter @chalito/api start
```

Then store the API key. Type it at the prompt; don't pipe it in (piped input is refused):

```sh
# Goes into the OS keychain (or the CHALITO_SECRETS file). Prompted, not echoed. Never in a shell variable or file.
chalito keys set anthropic
```

Check: `chalito status` shows the Anthropic key as present (never its value).

Also check the guards once:
- `echo y | chalito keys set anthropic` is refused (stdin is not a terminal).
- `CHALITO_SESSION=1 chalito pair` is refused (looks like an agent session).

## 2. Pair the test phone

1. Enrol the test phone as the user's first device. It exchanges a locally signed hub SSO token, then calls `POST /v1/devices/first`:
   ```sh
   pnpm tsx scripts/e2e-phone.ts enrol --uid "$HUB_UID"
   ```
2. Run `chalito pair`. It prints a short code and this computer's fingerprint, then waits.
3. Claim with the test phone. It resolves the code, verifies the glyph signature, shows the computer's fingerprint for you to compare, and claims:
   ```sh
   pnpm tsx scripts/e2e-phone.ts claim --code <SHORTCODE>
   ```
4. Back in the `chalito pair` terminal, compare the phone fingerprint it prints with the one `claim` printed (`e2e-phone.ts whoami` shows it again), and answer `s`/`y`.
5. Check: `~/.chalito/trusted-clients.json` lists one client with `via: "local_confirmation"`, and `chalito status` shows "paired".
6. Pin Claude Code. Pinning needs a paired computer. The daemon runs only the pinned binary and refuses one whose path or sha256 changed:
   ```sh
   chalito claude pin              # resolves `claude` on PATH once; or: chalito claude pin /path/to/claude
   ```
   `chalito status` shows `Claude Code: <path> (pinned, sha256 …)`. After a Claude Code update, run `chalito claude pin` again. Confirm the refusal once: if you skip pinning, `chalito run` stops with "No Claude Code (`claude`) is pinned".

## 3. Allow a workspace and start the agent

```sh
chalito policy path        # → ~/.chalito/policy.yaml
chalito policy edit        # opens $EDITOR on a private copy; applies only after you confirm the diff in this terminal
```

Add the workspace and save:

```yaml
workspaces:
  - label: e2e
    path: ~/chalito-e2e-ws
```

`chalito policy show` should list it, and the daemon log (next step) prints a new `policyHash`. Editing `policy.yaml` directly, without `chalito policy edit`, is refused: the signed `policy.lock` stays in force, and the daemon logs `policy.tampered`. Check that once. Leave everything else at the beta defaults: remote max mode `acceptEdits`, all origins on, TTL 600 s, Developer mode **off** (`chalito status`).

```sh
chalito run 2>&1 | tee ~/chalito-e2e.log
```

Wait for `agent.ready` with `workspaces: 1`. The log is JSON lines and redacted: no keys, tokens, emails or full phone numbers. Spot-check that as you go.

**Depends on** (tracked in `m3-agent`):
- **Local stack support in the daemon:** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` fill the `supabase` block of the config before pairing; `chalito pair` then signs them into `~/.chalito/config.json`.
- **Init logging:** the adapter should log the SDK `system/init` fields `apiKeySource`, `permissionMode`, `claude_code_version` and `mcp_servers` once per session (`adapter.init`). Steps 5.6 and 5.7 read them from there.

## 4. Start a session from the test client

In two extra terminals, start the approval inbox and (once you have the `sid`) the event feed:

```sh
pnpm tsx scripts/e2e-phone.ts approvals             # interactive: a = allow (with step-up when required), n = allow without step-up, d = deny, s = skip
pnpm tsx scripts/e2e-phone.ts sessions              # → sid
pnpm tsx scripts/e2e-phone.ts events --sid <sid>    # opens sealed events
```

Send a signed `session.start` (the prompt is sealed to the agent only):

```sh
pnpm tsx scripts/e2e-phone.ts start --workspace e2e --mode default --prompt "<prompt below>"
```

The prompt asks Claude to do the steps in section 5 one at a time and wait after each. For example:

> In this repo: 1) list the files and show git status; 2) create notes.txt with "hola"; 3) delete notes.txt with rm; 4) run `sudo true`; then stop.

Check that `session.started`, then `session.state: running`, appear in `chalito.session_events` for that sid, and that the Session Card updates (sealed; open it with the test client).

## 5. What to verify

**This step is the only place the real `claude` binary is exercised.** Everything else is covered without it:
- agent-core and the adapter run against the in-process fake Claude Code (`apps/agent/test/agent.test.ts`, `packages/adapters`);
- daemon wiring runs with injected fakes (`daemon.test.ts`);
- the Supabase path runs in the `supabase` CI job (`apps/agent/test/*.int.test.ts`, `apps/api/test/*.pg.test.ts`).

There is no stand-in binary and no test-only adapter switch in the daemon, by design: an env-selectable fake in production would be an attack surface. What only this run can show is how the real CLI and SDK behave: hook delivery, init metadata, interrupts, and settings isolation.

**First, read the `adapter.init` line** (one per session) in `~/chalito-e2e.log`. Every field must match, or the run is a **failure**: stop, keep the log, and report it.

| Field | Must be | Why |
|---|---|---|
| `apiKeySource` | `"ANTHROPIC_API_KEY"` | the BYO key from the keychain is in use. `none` means OAuth/claude.ai login; `/login managed key` or `apiKeyHelper` means a credential other than yours (D-002). |
| `permissionMode` | the mode you sent (`"default"` for step 4) | never `auto`, `dontAsk` or `bypassPermissions` (D-004) |
| `mcp_servers` | `[]` | `strictMcpConfig` loads no MCP servers (D-046) |
| `claude_code_version` | the version `claude --version` printed, from the binary you pinned | the pin holds |
| `model` | a Claude model id | sanity check that a real API call happened |

| # | Action Claude takes | Expected tier and outcome | Where to look |
|---|---|---|---|
| 5.1 | `LS`/`Glob`/`Read` in the workspace, `git status` | **LOW**: runs at once, with no `approvals/*` doc | events show `tool.started` / `tool.finished`; no approval doc |
| 5.2 | `Write notes.txt` | **MED**: an `approvals/{aid}` doc with `risk: MED`, `stepUpRequired: false`. Nothing happens until the test client signs allow; then the file exists. | approval doc `status: approved`, `reason: signed_allow`; `notes.txt` present |
| 5.3 | `rm notes.txt` | **HIGH**: `stepUpRequired: true`. In the inbox, answer `n` first (an allow **without** `stepUp`): the log shows `approval.decision_rejected … missing_step_up` and the tool still waits. Then answer `a` on the re-asked approval, or rerun the inbox with `--step-up always`, which signs with `stepUp.method: platform_biometric`: it runs. | log, approval doc, file gone |
| 5.4 | `sudo true` | **CRITICAL**: denied at once with `policy_block`, no approval doc. Claude receives "Chalito: policy_block". | card blocker "Bash bloqueado (policy_block)" |
| 5.5 | Any MED call, left unanswered (answer `s` in the inbox) | Denied after the TTL (shorten to `ttlSeconds: 60` locally for this step). The tool doesn't run; the approval goes to `expired` / `timeout_deny`. | approval doc, log |
| 5.6 | — | **Gate on every tool:** each `tool.started` has a matching gate decision in the log, and no tool ran without one. Compare `tool_use` ids. | `~/chalito-e2e.log` |
| 5.7 | — | `adapter.init` shows `permissionMode: "default"` (not `auto`, not `bypassPermissions`) and **`apiKeySource: "ANTHROPIC_API_KEY"`**. Any other value, such as `none` (OAuth) or `/login managed key`, is a **failure**: stop and report it. | `adapter.init` log line |
| 5.8 | — | `mcp_servers` is empty (`strictMcpConfig`, D-046) | `adapter.init` |
| 5.9 | `e2e-phone.ts mode --sid <sid> --mode acceptEdits`, then `prompt --sid <sid> --text "edit README.md"` | MED edit auto-allowed (D-047). A shell `rm` still asks with step-up. | approval docs |
| 5.10 | `e2e-phone.ts send-forbidden --mode bypassPermissions` | Rejected by the command schema; the device doc `lastEvent` shows `remote_enable.rejected` | device doc, log |
| 5.11 | `e2e-phone.ts replay-last --aid <a new pending aid>`: replays the last signed Decision | Rejected (`invalid_signature` for a wrong request, or `replayed_nonce`) and logged | log |
| 5.12 | Ask Claude to `echo x >> ~/.chalito/policy.yaml` | Denied with `hard_floor`; `policyHash` unchanged | log, `chalito policy show` |
| 5.13 | Ask Claude to run `chalito status`, then `yes \| chalito pair` | Both denied with `hard_floor`: a session never drives the agent CLI (review P2-1) | log |
| 5.14 | Ask Claude to `cp README.md ~/.local/bin/pkexec` | Denied (`policy_block`, CRITICAL: a PATH directory, review P2-2); nothing written | log, `ls ~/.local/bin` |

Also check the security-review items that need a real install (`docs/reviews/m3-security-review.md`):
- **#9 (project settings are not loaded):** put a `SessionStart` hook that runs `touch /tmp/chalito-hook-ran` in `~/chalito-e2e-ws/.claude/settings.json`, and add `"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:9"}`. Start a new session. Expected, since the adapter passes `settingSources: []`:
  - `/tmp/chalito-hook-ran` does **not** appear;
  - the session still reaches the API, because the base URL was ignored.
- **#12 (gate errors fail closed):** in `acceptEdits`, stop **your own** api (not a shared one) and ask for an edit to `.github/workflows/x.yml`. It must **not** be written, and Claude receives "Chalito: gate error".
- **P2-4 (interrupt and origin):** while a turn is running, send `e2e-phone.ts interrupt --sid <sid>`. Record whether the SDK emitted a `result` after the interrupt; the log shows `session.state` going to `idle` if it did. Then send a new prompt and check that the next turn's tool calls are gated normally.
- **P2-5 (`CLAUDE.md` symlink):** `ln -s ~/.ssh/known_hosts ~/chalito-e2e-ws/CLAUDE.md` (a harmless file outside the workspace), start a session, and ask Claude what its project instructions say. It must not know the file's contents. Remove the link afterwards.
- **Claude pin:** stop the daemon. Copy the binary (`cp "$(which claude)" /tmp/claude-copy`), `chalito claude pin /tmp/claude-copy`, then append a byte to the copy (`printf x >> /tmp/claude-copy`) and start the daemon. It must refuse with "Claude Code updated itself: run `chalito claude pin` again". Re-pin the real binary (`chalito claude pin`) and delete the copy.

## 6. Revoke and clean up

1. With a session waiting on an approval, run `e2e-phone.ts revoke-client` (a signed `device.revokeClient` for this phone). Check that the client is gone from `~/.chalito/trusted-clients.json` and its running sessions were interrupted.
2. Answer the approval that was pending at revoke time from the still-running `approvals` inbox: the agent log must show `approval.decision_rejected … untrusted_signer`. With no trusted client left, any **new** call that needs approval is denied at once (`untrusted_signer`, and no approval doc is created).
3. Run `e2e-phone.ts revoke` (`POST /v1/devices/revoke`), which cuts the phone's cloud credential. Any further `e2e-phone.ts` command now fails with `device_revoked`.
4. Stop `chalito run` (Ctrl-C), or `chalito service uninstall` if you installed the service.
5. Remove the key. With `CHALITO_SECRETS`, delete the scratch `HOME`; that removes the encrypted file too. Otherwise delete the keychain entry with service `com.chalito.agent` and account `byo-anthropic-api-key` (Keychain Access, `secret-tool clear service com.chalito.agent username byo-anthropic-api-key`, or Credential Manager). **Rotate the API key** in the Console if it was ever pasted anywhere else.
6. `rm -rf ~/chalito-e2e-ws ~/.chalito-e2e-phone.json`. Keep `~/chalito-e2e.log` for the results, after checking it holds no secrets. Delete `~/.chalito` only if you won't use this machine with Chalito again.

## Results

Fill in after the run and commit with the M3 PR.

- Date / machine / OS:
- `claude --version`:
- SDK version (`@anthropic-ai/claude-agent-sdk`):
- 5.1–5.12: pass/fail, with notes per row
- Review #9 (project hooks):
- Review #12 (gate error under acceptEdits):
- Anything unexpected:
