import type { AdapterKind, Origin, RemotePermissionMode, SessionState } from "@chalito/protocol";

/**
 * Adapter-neutral session interface shared by Claude Code (M3), Codex (M4) and ACP
 * (stretch). The agent owns policy; adapters only translate.
 */
export interface ToolCall {
  sid: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Origin of the turn this call belongs to. */
  origin: Origin;
}

export type GateResult = { allow: true; updatedInput?: Record<string, unknown> } | { allow: false; reason: string };

/** Every tool call goes through this before it runs (policy, approvals). */
export type ToolGate = (call: ToolCall, signal: AbortSignal) => Promise<GateResult>;

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** An agent question for the human (AskUserQuestion / Codex user input). Not an approval. */
export type AskUser = (
  q: { sid: string; questionId: string; questions: Question[] },
  signal: AbortSignal,
) => Promise<Record<string, string | string[]>>;

export type AdapterEvent =
  | { type: "started"; providerSessionId: string }
  | { type: "assistant_text"; text: string }
  /**
   * The next piece of the assistant text being written (M16 A partial streaming). Display only:
   * the agent throttles and broadcasts it, and the `assistant_text` that follows is the message.
   */
  | { type: "assistant_delta"; text: string }
  | { type: "tool_started"; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_finished"; toolUseId: string; ok: boolean }
  | { type: "usage"; tokIn: number; tokOut: number; tokCacheRead: number; tokCacheWrite: number; model?: string }
  | { type: "state"; state: SessionState }
  | {
      type: "error";
      code: "adapter_crash" | "auth_required" | "rate_limited" | "quota_exhausted" | "internal";
      message?: string;
    };

/** A local stdio MCP server the agent attaches to a session (computer control). */
export interface LocalMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Whether `tool` with `input` is one of this server's tools with valid arguments. An adapter
   * that can only infer a call's server from what the agent reports (ACP titles) names a call
   * after this server only when it holds; without it, such a call is never named as ours.
   */
  isTool?: (tool: string, input: Record<string, unknown>) => boolean;
}

export interface SessionStartOptions {
  sid: string;
  cwd: string;
  /**
   * The first turn's prompt. Empty only with `resume`: the session is reopened without a turn
   * (state idle) and waits for `prompt()`.
   */
  prompt: string;
  origin: Origin;
  permissionMode: RemotePermissionMode;
  /**
   * Provider session id to resume (Claude session_id, Codex thread id, ACP sessionId). Claude
   * passes it as the SDK's `resume`, Codex as `thread/resume`, ACP as `session/resume` or
   * `session/load` when the agent advertises one (else a new session).
   */
  resume?: string;
  gate: ToolGate;
  askUser: AskUser;
  onEvent: (e: AdapterEvent) => void;
  /**
   * Agent-owned local MCP servers for this session, by name (today only computer control, when
   * the person turned it on locally). Nothing else: adapters keep refusing any other MCP server.
   */
  mcpServers?: Record<string, LocalMcpServer>;
}

export interface SessionHandle {
  prompt(text: string, origin: Origin): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: RemotePermissionMode): Promise<void>;
  /** Ends the session (closes input). */
  close(): void;
  readonly done: Promise<void>;
}

export interface SessionAdapter {
  readonly kind: AdapterKind;
  /**
   * The adapter accepts `mcpServers` (the agent's own local servers) and puts each of their tool
   * calls through the gate as `mcp__<server>__<tool>`. Missing = never given any.
   */
  readonly localMcp?: boolean;
  start(opts: SessionStartOptions): Promise<SessionHandle>;
}

/** A pushable async iterable (the streaming-input queue). */
export class InputQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
