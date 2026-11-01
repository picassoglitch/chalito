# Central connections

Chalito's desktop Sessions tab can start and follow tasks on any of the account's linked computers. The web New Session page uses the same per-computer tool list. Tasks, prompts and interrupts use the existing signed command channel; prompts are encrypted for the selected computer. Tool credentials remain on that computer.

## Connecting and using a tool

1. Sign in to Chalito on each computer. Install the desired tool through Connected AI on the computer where it will run.
2. For a tool with supported account sign-in, click Connect. Finish the tool's own sign-in in the browser on that computer. The connection remains pending until the tool reports success.
3. Allow the tool's sessions on its computer. This remains a local setting.
4. From Connected AI on any linked desktop, view each computer's tool status, request supported account sign-in, or refresh its tool list.
5. In Sessions, choose the computer, one of its ready tools, and an allowed folder. Start the task, follow its conversation, and approve actions here. Existing sessions are grouped by computer and can be reopened.

Account sign-in is the primary path where supported. API credentials remain under Advanced options for existing users. Opening a website or desktop app is explicitly distinguished from connecting its tools.

## Compatibility and boundaries

### Native app connections

The Connected AI tab now has native connectors for Codex, Claude Code, and Cursor. Click Connect app on the computer running that tool, review the settings change, and confirm with operating-system authentication. Chalito preserves other hooks and settings and saves a local backup of the previous settings file in `~/.chalito/native-backups/`. A backup is a full copy, so it contains any credentials stored in that file (for example an API key in `env`); backups are readable only by your user account, and only the newest three per app are kept. Each app keeps its own login; these connectors require no AI API key, never send provider credentials anywhere, and do not read transcript files.

The connector installs supported lifecycle and pre-tool hooks. Start or restart a native session after installation; Codex also requires trusting the hooks through its `/hooks` flow. Installation is shown separately from a session actually contacting Chalito. Linked sessions forward supported prompt/reply lifecycle messages and send tool requests through Chalito's existing policy checks and signed human approvals. Disconnect cancels outstanding requests and works even if Chalito's own connector record was lost; it finds Chalito's hooks by their command.

Chalito decides only for actions that land in its workspaces. A request is inside when its folder, the shell's working folder, a file it names, or any of Cursor's open roots is in a workspace, even if the app was opened elsewhere; `~` workspaces count as the folder they name. When nothing a request touches is in a workspace, the hook gives no decision and the app's own permission flow runs. Targets in two different workspaces are denied. Inside a workspace, malformed, oversized, or failed requests are denied with a specific reason. If Chalito is not running, the hook reads the workspace list that the agent keeps in `~/.chalito/native-workspaces.json` and applies the same targets: it denies actions inside workspaces and gives no decision elsewhere. If that file is missing or unreadable, the hook denies; the agent deletes it when it cannot write a current one. A request over 1 MB is judged from its first 16 KB. If the hook itself crashes on a tool request, it denies the request (Claude Code and Cursor also get exit code 2). Codex receives no output for an allowed action, because Codex rejects an explicit allow. The native app must enable and execute its hook for this protection to apply.

These native sessions are explicitly marked as approval connections. Their prompt, stop, and process controls remain in the original app. Starting and chatting with sessions from mobile uses the managed adapters described above. Universal native process control is not implemented, and each additional AI tool needs an adapter or supported hook integration.

Native tests exercise all three vendor response formats through the local RPC protocol, real approval policy, and a signed human decision, plus encrypted message forwarding, cancellation, workspace protection, and settings preservation. They do not replace testing the packaged connector in each installed vendor app.

- Update Chalito on both controlling and tool-hosting computers for connection reports and reliable remote-start confirmation. Tool reports travel in `presence.tools`, beside `presence.setup`, because released clients and the hub parse `setup` strictly; they keep reading the setup from new agents. Older agents without tool reports retain their pinned-tool list as a compatibility fallback.
- A tool must report a ready account state and have sessions enabled to appear in the new tool picker. The receiving agent still enforces policy, binary trust, workspace scope, and approvals.
- Each `session.started` event may include its initiating command ID. Desktop and web clients match that ID and the target device, so another task starting concurrently cannot open the wrong session.
- Offline computers cannot receive new starts through these forms. Previously reported connection status is displayed alongside the computer's offline status.
- Sign-in requires that tool's supported account flow. Existing provider restrictions remain enforced. In particular, this change does not enable restricted Claude or Codex consumer-plan authentication or introduce token copying from other applications. Codex's current commercial-integration conditions are documented in the [official app-server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints).
- This is remote access to tools and sessions, not an automatic migration of files or merging of different tools' conversation histories. Existing explicit agent links and coordinator controls remain available separately.

No database migration, deployment, or release publication is required to review the code changes. Updated desktop/agent binaries and the web build must be released before users can use them.

## Validation

The desktop integration tests execute real signed client commands against AgentCore with a scripted tool adapter. They cover remote starts, follow-up prompts, interrupts, routing across tab switches, offline targets, and concurrent session starts. Separate tests cover account-sign-in command construction, confirmed connection status, and keeping credentials and paths out of device tool reports.

## Session links

The desktop and web session views offer **Link this session** and recognize `/link` in managed session message boxes. `chalito code` also recognizes `/link` after a session starts. This prints the session page in the Chalyb hub (`https://www.chalyb.com/app/chalito/sesiones/<id>`); it sends no AI prompt, includes no bearer credential, and does not grant access to someone outside the account. Native connectors provide a session link through their session-start hook where the app supports additional context; a link alone does not install or authorize a connector.

The small LCD approval screen is described in [LCD_APPROVAL_CONSOLE.md](LCD_APPROVAL_CONSOLE.md).
