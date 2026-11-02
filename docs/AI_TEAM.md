# Automatic communication between installed AIs

Chalito provides a local `chalito_team` MCP server for Claude Code, Codex, Grok Build and Cursor. Each running AI session connects to Chalito's existing same-user socket. Sessions in the same configured Chalito workspace discover each other and exchange status updates, help requests and results. No provider API keys or copied logins are needed for messaging.

The MCP instructions tell each AI to coordinate automatically: check messages at task start and between meaningful steps, announce its work, ask teammates for relevant help, and return results without making the user relay messages. Each AI must support MCP and choose to follow those instructions. The channel does not wake idle agents, launch additional AI processes, or inject prompts into an app that is not reading messages.

## Connect an app

1. Run an updated Chalito agent and add the project folder to its configured workspaces.
2. Generate the launch configuration for that app and project:

   ```sh
   chalito team config claude /absolute/path/to/project
   chalito team config codex /absolute/path/to/project
   chalito team config grok /absolute/path/to/project
   chalito team config cursor /absolute/path/to/project
   ```

   Each command prints a JSON `mcpServers.chalito_team` entry containing the actual executable and arguments for this installation. It does not change the app's settings. The underlying command is `chalito team mcp <provider> <workspace-path>`.

3. Register that command and argument array in the app's MCP settings as `chalito_team`, preserving other servers. For a client with a different configuration format, use the printed `command` and `args` values in its own stdio-server format. Use a project-specific configuration or a separate entry for each project; the explicit workspace path controls where messages go, regardless of the MCP process's starting directory.
4. Restart or reconnect the app's MCP servers, and trust the connection using the app's normal controls. Its tool permissions still apply. `team_read` reports the other connected sessions. Ask the AI to use Chalito for automatic coordination on the current task; the MCP initialization instructions carry this behavior into subsequent connections.

The native approval hooks and this messaging connection are separate. Installing an approval hook alone does not register this MCP server. The desktop Connected AI buttons do not yet install the team MCP configuration automatically. Existing sessions require reconnection before they can use these tools. The implementation has been verified with four MCP clients against the local RPC server; live vendor-app acceptance and packaged installation still need validation.

Coordinator mode controls which routine approval prompts Chalito answers. It is not required for these messaging tools and does not connect an MCP client. The workspace policy must include the selected project. A policy containing only `~/projects` will reject `/home/picassoglitch/chalito`. Update it through `chalito policy edit` in a normal terminal before testing; use an absolute path, since `~` expansion inside configuration is not guaranteed. If you also want coordinator approval behavior, enable it separately with `chalito coordinator enable`.

## Tools and delivery

- `team_read {}` returns the current session ID, active peers, and unread messages.
- `team_send {"to":"<peer-id>","kind":"request","text":"Review this approach"}` sends a direct message. `kind` can also be `status` or `result`. Omit `to` to broadcast to the workspace. Sending also reads pending messages.

Requests are peer data within the user's existing task, not owner instructions or action approvals. Sending a message never executes a tool or changes another app's permissions. Provider names identify the client's declared app; any process belonging to the same operating-system user can use the socket, so those names are not authenticated vendor identities. The channel cannot reach another account or computer.

Messages are in memory, limited to 8,000 characters each, 30 sends per connection per minute, and 64 retained messages across the agent. Retention is at most one hour for delivery. `historyTruncated` reports when the retained sequence no longer covers the reader's position. This is a bounded coordination channel, not a durable task queue: peers should confirm important requests with a result, and must not claim completion based on sending alone. Avoid forwarding loops and repeated acknowledgments.

Disconnect removes the peer immediately. Its queued results remain available to other connected peers in that workspace until retention expires; the workspace history is discarded when its last peer leaves. Joining peers see messages sent after they join. Restarting Chalito clears all team state. Workspace access is checked against current policy for each call; removing a workspace disconnects its membership on its next call.

## Local development

From `apps/agent`, `node --import tsx src/cli.ts team config claude /absolute/project` prints a development launch configuration without the `tsx` CLI's extra IPC listener. Production uses the compiled agent binary.

Validation:

```sh
pnpm --filter @chalito/agent exec vitest run test/team.test.ts test/links.test.ts
pnpm --filter @chalito/agent typecheck
```

## Live Claude–Codex acceptance check (pending)

Run this in a normal terminal with access to the installed applications and Chalito's sockets. The test harness does not substitute for this check.

1. Run an agent built from this branch. An older running agent does not have the `team` RPC method. Configure an allowed project path and reconnect both apps to the new MCP launch commands for that same path.
2. Open a real Claude Code session and a real Codex session. Verify each app lists `chalito_team` and both tools. Ask each to call `team_read`; each must report the other as an active peer.
3. In Claude: "Use Chalito to send Codex a direct request: return the text TEAM-LIVE-ACK-20261101 and explain in one sentence what the team channel does. This is a messaging test; do not edit files or run commands. Read its reply."
4. In Codex: "Use Chalito to read pending team requests and answer Claude through team_send with kind result. Do not edit files or run commands."
5. Have Claude call `team_read` again. Record the request and matching result, sender IDs, workspace, and nonce. This confirms a request/result handoff through actual vendor sessions; it does not verify that an idle app wakes automatically.
6. Start one session with a different configured workspace and confirm it cannot see these peers or send to their IDs. Close Codex's MCP connection and confirm Claude no longer lists it.

Record the agent revision, vendor versions, and observed tool results in the PR before marking this check complete. The sandbox used for development denies Unix socket operations (`EPERM`), and outside-sandbox execution is disabled in this session, so this check has not been run here.
