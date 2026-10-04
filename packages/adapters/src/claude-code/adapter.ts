import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isSignedOrigin, type Origin, type RemotePermissionMode } from "@chalito/protocol";
import {
  InputQueue,
  type Question,
  type SessionAdapter,
  type SessionHandle,
  type SessionStartOptions,
} from "../core.js";

/** The slice of the SDK's Query the adapter uses. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: RemotePermissionMode): Promise<unknown>;
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export interface ClaudeCodeConfig {
  /** BYO Anthropic API key from the OS keychain (D-002: API key only). */
  apiKey: string;
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
  /** Injected in tests; reads the workspace CLAUDE.md. */
  readFile?: (path: string) => Promise<string>;
}

/** Cap on the CLAUDE.md text appended to the system prompt. */
const CLAUDE_MD_MAX = 64 * 1024;

/** Credentials that would take precedence over the API key, or route through a subscription. */
const STRIPPED_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_API_KEY",
  // Anything that could send the key somewhere other than api.anthropic.com.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

const ORIGIN_TRUST = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
/** The less trusted of two origins (unsigned mcp:/call: < client: < local); ties keep `a`. */
export const lowerTrustOrigin = (a: Origin, b: Origin): Origin => (ORIGIN_TRUST(b) < ORIGIN_TRUST(a) ? b : a);

export const claudeEnv = (
  base: Record<string, string | undefined>,
  apiKey: string,
): Record<string, string | undefined> => {
  const env = { ...base };
  for (const k of STRIPPED_ENV) delete env[k];
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
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
    const input = new InputQueue<SDKUserMessage>();
    // The origin of the turn the SDK is running. A prompt queued mid-turn must not change the
    // running turn's origin, so queued origins apply only at the turn boundary (`result`). If
    // several prompts queue up, the next turn takes the least trusted of them, since the CLI
    // may fold them into one turn.
    let origin: Origin = opts.origin;
    let turnActive = true;
    let pendingOrigins: Origin[] = [];
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
      permissionMode: opts.permissionMode,
      allowDangerouslySkipPermissions: false,
      settingSources,
      strictMcpConfig: true,
      env: claudeEnv(this.config.env ?? process.env, this.config.apiKey),
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: this.config.hookTimeoutSec ?? 660 }] },
      canUseTool,
      ...(this.config.claudePath ? { pathToClaudeCodeExecutable: this.config.claudePath } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
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
        for await (const msg of q) {
          this.#map(msg, opts);
          if ((msg as { type: string }).type === "result") turnEnded();
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
        if (turnActive) pendingOrigins.push(turnOrigin);
        else {
          origin = turnOrigin;
          turnActive = true;
        }
        opts.onEvent({ type: "state", state: "running" });
        input.push(userMessage(text));
      },
      interrupt: async () => {
        await q.interrupt();
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      setPermissionMode: async (mode) => {
        await q.setPermissionMode(mode);
      },
      close: () => input.close(),
      done,
    };
  }

  async #workspaceClaudeMd(cwd: string): Promise<string | null> {
    const read = this.config.readFile ?? ((p: string) => readFile(p, "utf8"));
    for (const p of [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md")]) {
      try {
        const text = (await read(p)).slice(0, CLAUDE_MD_MAX).trim();
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
