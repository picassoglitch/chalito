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
  | { type: "tool_started"; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_finished"; toolUseId: string; ok: boolean }
  | { type: "usage"; tokIn: number; tokOut: number; tokCacheRead: number; tokCacheWrite: number; model?: string }
  | { type: "state"; state: SessionState }
  | {
      type: "error";
      code: "adapter_crash" | "auth_required" | "rate_limited" | "quota_exhausted" | "internal";
      message?: string;
    };

export interface SessionStartOptions {
  sid: string;
  cwd: string;
  prompt: string;
  origin: Origin;
  permissionMode: RemotePermissionMode;
  /** Provider session id to resume (Claude session_id, Codex thread id). */
  resume?: string;
  gate: ToolGate;
  askUser: AskUser;
  onEvent: (e: AdapterEvent) => void;
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
