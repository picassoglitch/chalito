import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { RemotePermissionMode, isSignedOrigin, type Origin } from "@chalito/protocol";
import {
  InputQueue,
  type Question,
  type SessionAdapter,
  type SessionHandle,
  type SessionStartOptions,
} from "../core.js";
import { envAllowed } from "../env.js";

/** The slice of the SDK's Query the adapter uses. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: RemotePermissionMode): Promise<unknown>;
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

/**
 * How Claude Code authenticates: a BYO Anthropic API key from the OS keychain (D-002), or, for
 * the Chalito team only (providers.yaml `anthropic.subscriptionLocal: owner_only`), the person's
 * own `claude auth login` kept in Chalito's own Claude Code profile (`CLAUDE_CONFIG_DIR`).
 * Chalito never reads that profile's credentials.
 */
export type ClaudeAuth = string | { configDir: string };

export interface ClaudeCodeConfig {
  /** BYO Anthropic API key from the OS keychain (D-002), or a sign-in profile (ClaudeAuth). */
  apiKey: ClaudeAuth;
  /** The user's own Claude Code install (D-008). */
  claudePath?: string;
  /**
   * Defaults to [] (SDK isolation): project settings are repo-controlled and can carry hooks
   * that run outside the gate, `env` that redirects the API key, or an apiKeyHelper. The
   * workspace CLAUDE.md is appended to the system prompt instead.
   */
  settingSources?: ("user" | "project" | "local")[];
  model?: string;
  /** Must exceed the 10-minute approval window (PreToolUse default is 600 s; timeout = tool doesn't run). */
  hookTimeoutSec?: number;
  /** Injected in tests (fake Claude Code); defaults to the real SDK. */
  queryFn?: QueryFn;
  /** Base environment (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Called once per session with the SDK's init metadata (for the `adapter.init` log). */
  onInit?: (info: ClaudeCodeInitInfo) => void;
}

export interface ClaudeCodeInitInfo {
  sid: string;
  providerSessionId: string;
  /** "ANTHROPIC_API_KEY" proves the BYO key is in use; anything else is a misconfiguration. */
  apiKeySource: string;
  permissionMode: string;
  claude_code_version: string;
  /** Server names only. */
  mcp_servers: string[];
  model: string;
}

/** Longer than the 10-minute approval window: a computer-control call may wait for one. */
export const MCP_TOOL_TIMEOUT_MS = 11 * 60 * 1000;

/** Cap on the CLAUDE.md text appended to the system prompt; larger files are skipped. */
const CLAUDE_MD_MAX = 64 * 1024;

const ORIGIN_TRUST = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
/** The less trusted of two origins (unsigned mcp:/call: < client: < local); ties keep `a`. */
export const lowerTrustOrigin = (a: Origin, b: Origin): Origin => (ORIGIN_TRUST(b) < ORIGIN_TRUST(a) ? b : a);

export const claudeEnv = (
  base: Record<string, string | undefined>,
  auth: ClaudeAuth,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && envAllowed(k)) env[k] = v;
  // Marks the session's own processes; the chalito CLI refuses to run under it.
  env.CHALITO_SESSION = "1";
  // With a key the CLI never falls back to a login; with a sign-in it uses only Chalito's own
  // profile, never the person's ~/.claude.
  if (typeof auth === "string") env.ANTHROPIC_API_KEY = auth;
  else env.CLAUDE_CONFIG_DIR = auth.configDir;
  return env;
};

type InitMessage = Partial<Extract<SDKMessage, { type: "system"; subtype: "init" }>> & { session_id: string };
const isInit = (m: SDKMessage): m is SDKMessage & InitMessage =>
  m.type === "system" && (m as { subtype?: string }).subtype === "init";

/** Types aren't enough at runtime: anything outside default|plan|acceptEdits is refused, never forwarded. */
const checkedMode = (mode: unknown): RemotePermissionMode => {
  const r = RemotePermissionMode.safeParse(mode);
  if (!r.success) throw new Error(`Refused permission mode ${JSON.stringify(String(mode)).slice(0, 40)}`);
  return r.data;
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly kind = "claude-code" as const;

  constructor(private readonly config: ClaudeCodeConfig) {}

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    const startMode = checkedMode(opts.permissionMode);
    const input = new InputQueue<SDKUserMessage>();
    // The origin of the turn the SDK is running. A prompt can only LOWER it right away (the CLI
    // may fold a queued message into the running turn); it is raised only at a confirmed turn
    // boundary (`result`, or interrupt()), to the least trusted of the prompts queued since.
    let origin: Origin = opts.origin;
    let turnActive = true;
    let pendingOrigins: Origin[] = [];
    // After interrupt() the interrupted turn's own `result` may still arrive; it is not a new boundary.
    let skipNextResult = false;
    const turnEnded = () => {
      if (pendingOrigins.length === 0) {
        turnActive = false;
        return;
      }
      origin = pendingOrigins.reduce(lowerTrustOrigin);
      pendingOrigins = [];
    };
    // Tool uses the PreToolUse gate approved; canUseTool only allows these (plus AskUserQuestion).
    const approved = new Set<string>();

    const preToolUse: HookCallback = async (hookInput, _toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      // Fail closed: a throwing gate must never fall through to the SDK's own permission flow
      // (acceptEdits would auto-approve edits without canUseTool).
      let res: Awaited<ReturnType<typeof opts.gate>>;
      try {
        res = await opts.gate(
          {
            sid: opts.sid,
            toolUseId: hookInput.tool_use_id,
            toolName: hookInput.tool_name,
            input: (hookInput.tool_input ?? {}) as Record<string, unknown>,
            origin,
          },
          signal,
        );
        if (signal.aborted) res = { allow: false, reason: "aborted" };
      } catch {
        res = { allow: false, reason: "gate error" };
      }
      if (res.allow) approved.add(hookInput.tool_use_id);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: res.allow ? "allow" : "deny",
          permissionDecisionReason: res.allow ? "Approved by Chalito" : `Chalito: ${res.reason}`,
          ...(res.allow && res.updatedInput ? { updatedInput: res.updatedInput } : {}),
        },
      };
    };

    const canUseTool: CanUseTool = async (toolName, toolInput, { toolUseID, signal }) => {
      if (toolName === "AskUserQuestion") {
        const questions = (toolInput.questions ?? []) as Question[];
        const answers = await opts.askUser({ sid: opts.sid, questionId: toolUseID, questions }, signal);
        return { behavior: "allow", updatedInput: { ...toolInput, answers } };
      }
      if (approved.has(toolUseID)) return { behavior: "allow", updatedInput: toolInput };
      return { behavior: "deny", message: "Not approved by Chalito" };
    };

    const settingSources = this.config.settingSources ?? [];
    const claudeMd = settingSources.includes("project") ? null : await this.#workspaceClaudeMd(opts.cwd);
    const options: Options = {
      cwd: opts.cwd,
      // Always explicit: an omitted mode may resolve to `auto` in SDK ≥ 0.3.286.
      permissionMode: startMode,
      allowDangerouslySkipPermissions: false,
      settingSources,
      strictMcpConfig: true,
      env: claudeEnv(this.config.env ?? process.env, this.config.apiKey),
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: this.config.hookTimeoutSec ?? 660 }] },
      canUseTool,
      ...(this.config.claudePath ? { pathToClaudeCodeExecutable: this.config.claudePath } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      // Only the agent's own local servers (computer control); strictMcpConfig keeps out every
      // other source. Their tool calls still go through the PreToolUse gate above.
      ...(opts.mcpServers && Object.keys(opts.mcpServers).length
        ? {
            mcpServers: Object.fromEntries(
              Object.entries(opts.mcpServers).map(([name, m]) => [
                name,
                // A first call may wait for the person's approval (up to 10 minutes).
                { type: "stdio" as const, command: m.command, args: m.args, env: m.env, timeout: MCP_TOOL_TIMEOUT_MS },
              ]),
            ),
          }
        : {}),
      ...(claudeMd
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: `Contents of the workspace CLAUDE.md (project instructions):\n\n${claudeMd}`,
            },
          }
        : {}),
    };

    const q = (this.config.queryFn ?? (sdkQuery as unknown as QueryFn))({ prompt: input, options });
    input.push(userMessage(opts.prompt));
    opts.onEvent({ type: "state", state: "running" });

    const done = (async () => {
      try {
        let initLogged = false;
        for await (const msg of q) {
          if (!initLogged && this.config.onInit && isInit(msg)) {
            initLogged = true;
            this.config.onInit({
              sid: opts.sid,
              providerSessionId: msg.session_id,
              apiKeySource: String(msg.apiKeySource ?? "unknown"),
              permissionMode: String(msg.permissionMode ?? "unknown"),
              claude_code_version: String(msg.claude_code_version ?? "unknown"),
              mcp_servers: (msg.mcp_servers ?? []).map((m) => m.name),
              model: String(msg.model ?? "unknown"),
            });
          }
          this.#map(msg, opts);
          if ((msg as { type: string }).type === "result") {
            if (skipNextResult) skipNextResult = false;
            else turnEnded();
          }
        }
        opts.onEvent({ type: "state", state: "completed" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.onEvent({
          type: "error",
          code: /auth|api key|401/i.test(message) ? "auth_required" : "adapter_crash",
          message,
        });
        opts.onEvent({ type: "state", state: "failed" });
      }
    })();

    return {
      prompt: (text, turnOrigin) => {
        if (turnActive) {
          pendingOrigins.push(turnOrigin);
          origin = lowerTrustOrigin(origin, turnOrigin);
        } else {
          origin = turnOrigin;
          turnActive = true;
        }
        opts.onEvent({ type: "state", state: "running" });
        input.push(userMessage(text));
      },
      interrupt: async () => {
        await q.interrupt();
        if (turnActive) {
          skipNextResult = true;
          turnEnded();
        }
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      setPermissionMode: async (mode) => {
        await q.setPermissionMode(checkedMode(mode));
      },
      close: () => input.close(),
      done,
    };
  }

  /** The workspace CLAUDE.md: a regular file (no symlinks), really inside the workspace, at most CLAUDE_MD_MAX bytes. */
  async #workspaceClaudeMd(cwd: string): Promise<string | null> {
    let root: string;
    try {
      root = await realpath(cwd);
    } catch {
      return null;
    }
    for (const p of [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md")]) {
      try {
        const st = await lstat(p);
        if (!st.isFile() || st.size > CLAUDE_MD_MAX) continue;
        // lstat only checks the last component; a symlinked .claude/ is caught here.
        const real = await realpath(p);
        if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
        const text = (await readFile(real, "utf8")).slice(0, CLAUDE_MD_MAX).trim();
        if (text) return text;
      } catch {
        /* not present */
      }
    }
    return null;
  }

  #map(msg: SDKMessage, opts: SessionStartOptions): void {
    const m = msg as {
      type: string;
      subtype?: string;
      session_id?: string;
      message?: { content?: unknown };
      usage?: Record<string, number>;
    };
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      opts.onEvent({ type: "started", providerSessionId: m.session_id });
      return;
    }
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content as {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }[]) {
        if (block.type === "text" && block.text) opts.onEvent({ type: "assistant_text", text: block.text });
        if (block.type === "tool_use" && block.id && block.name) {
          opts.onEvent({
            type: "tool_started",
            toolUseId: block.id,
            toolName: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      return;
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content as { type: string; tool_use_id?: string; is_error?: boolean }[]) {
        if (block.type === "tool_result" && block.tool_use_id)
          opts.onEvent({ type: "tool_finished", toolUseId: block.tool_use_id, ok: !block.is_error });
      }
      return;
    }
    if (m.type === "result") {
      const u = m.usage ?? {};
      opts.onEvent({
        type: "usage",
        tokIn: u.input_tokens ?? 0,
        tokOut: u.output_tokens ?? 0,
        tokCacheRead: u.cache_read_input_tokens ?? 0,
        tokCacheWrite: u.cache_creation_input_tokens ?? 0,
      });
      opts.onEvent({ type: "state", state: "idle" });
    }
  }
}
