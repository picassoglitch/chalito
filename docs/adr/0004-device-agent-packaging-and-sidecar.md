# ADR 0004: Device agent packaging, OS service, and Tauri sidecar

- Status: Proposed (M0), confirm with owner decision #21

## Context (verified 2026-10-03, see VERIFIED_APIS §Desktop)
- Node 22 SEA is still Stability 1.1 and CommonJS-only. `--build-sea` exists only from Node 25.5.
- `@anthropic-ai/claude-agent-sdk` 0.3.x **no longer ships `cli.js`**. It spawns a native `claude` binary (~245 MB per platform) from per-platform optional deps, or the path in `pathToClaudeCodeExecutable`.
- `keytar` is archived. `@napi-rs/keyring` 2.x is maintained, with prebuilds for all three OSes.
- A Windows **Service** runs as LocalSystem and cannot read the user's Credential Manager entries. Per-user autostart is required.

## Decision
1. **Build:** `chalito-agent` is TypeScript on Node 22 APIs, compiled to one executable per OS/arch with **`bun build --compile`**. Fallback: `@yao-pkg/pkg`. Native addons are limited to `@napi-rs/keyring`. Crypto uses `libsodium-wrappers` (wasm). A smoke test in M3 proves the keyring addon loads inside the compiled binary.
2. **Claude Code binary:** by default the agent **uses the user's own installed Claude Code** (`claude` on PATH, installed through Anthropic's official installer) via `pathToClaudeCodeExecutable`, after a version-compatibility check.
   - If it's missing, onboarding links to Anthropic's installer.
   - We don't redistribute the binary in the beta. That keeps downloads small and keeps Claude Code unmodified and sourced from Anthropic.
   - Bundling is possible later under the Commercial Terms (owner decision #21).
   - Codex works the same way (`codex` CLI from OpenAI's installer).
   - **Codex auth: ChatGPT plan via Sign in with ChatGPT (SIWC), plus API key** (owner decision #26, 2026-10-03: "we need to make it work").
     - OpenAI states that Codex's built-in app-server login "has never been permitted for commercial or hosted services", so we don't use `account/login/start {type:"chatgpt"}`.
     - We implement OpenAI's **official SIWC "ChatGPT plan usage" flow**: PKCE at `auth.openai.com`, loopback redirect, and the token handed to `codex app-server` through the `openai_chatgpt_plan` model provider. The agent refreshes the token and restarts app-server, then calls `thread/resume`.
     - The UI follows OpenAI's SIWC rules: a "Continue with ChatGPT" button, "Using ChatGPT plan" + "Manage usage". Only Plus and Pro users are eligible.
     - **Gate:** the self-serve client (`dynamic_agent_client`) is documented for open-source and locally hosted apps. Paid apps need OpenAI's SIWC partner approval. So the flow ships behind `providers.yaml: openai.subscriptionLocal` with three modes: `owner_only` (on for OWNER_UIDS and dev), `approved` (all users, once OpenAI approves), and `off`. Default: `owner_only`. **OPS:** the owner submits OpenAI's SIWC interest form.
   - `codex app-server` is labelled experimental ("not supported for production workloads"). The adapter pins a tested Codex version range and runs the conformance suite on upgrades.
3. **Auth pinning:** the adapter passes `permissionMode: 'default'` explicitly. Since SDK 0.3.286 an omitted mode may resolve to `auto`.
   - The beta uses BYO **API key only** (VERIFIED_APIS §Anthropic; owner decision #19). The key comes from the OS keychain and is passed through `options.env.ANTHROPIC_API_KEY`, so the CLI never silently falls back to the user's claude.ai login.
   - The agent never reads `~/.claude/.credentials.json`.
   - `settingSources` defaults to `['project']` so user-level hooks or `defaultMode` can't change the starting mode. Users can opt into `user` locally.
4. **Lifecycle owner = the OS user service.** There is no second owner.
   - macOS: `~/Library/LaunchAgents/com.chalito.agent.plist` (RunAtLoad, KeepAlive).
   - Linux: `~/.config/systemd/user/chalito-agent.service` (`systemctl --user enable --now`; linger offered, not forced).
   - Windows: a **per-user Scheduled Task** (logon trigger, restart on failure), falling back to an `HKCU\…\Run` key. **Not a Windows Service** (deviation D-005).
5. **Tauri sidecar:** the desktop app ships the agent as `bundle.externalBin` (`binaries/chalito-agent-<target-triple>`). On first run, with consent, it copies the binary to a per-user location and registers the service. After that the app **talks to the running agent over local IPC**: a Unix domain socket `~/.chalito/agent.sock` (0600), or a Windows named pipe with a per-user ACL. It doesn't spawn the agent on each launch. The macOS universal build requires a lipo'd universal sidecar.
6. **CLI:** the same binary answers `chalito <cmd>` (pair, devmode, policy, status, uninstall).

## Consequences
- The agent binary is ~60–100 MB without Claude Code (bun runtime + deps). The `claude` binary is the user's.
- macOS: the bun binary needs hardened-runtime JIT entitlements and must be signed and notarized together with the app.
- Linux keychain needs a Secret Service on the session D-Bus. Headless setups fall back to an encrypted file keyed by a passphrase prompt (documented, M3).
