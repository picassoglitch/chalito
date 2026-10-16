import {
  isTerminalLinkState,
  type LinkArtifact,
  type LinkMessage,
  type LinkPart,
  type LinkStreamResponse,
  type LinkTask,
  type LinkTaskState,
  type LinkTaskStatus,
} from "@chalito/protocol";
import type { AdapterEvent } from "./core.js";

/**
 * Projects one session's `AdapterEvent` stream onto A2A-shaped `LinkTask` updates (ADR 0022 §2).
 * It lives here, not in packages/protocol, because `AdapterEvent` is this package's type and
 * protocol must not depend on adapters (D-067).
 *
 * - The session is one long-lived `contextId`; each `prompt()` opens a new task in it.
 * - `state` events move the open task: running → WORKING, waiting_input → INPUT_REQUIRED,
 *   idle/completed → COMPLETED, failed → FAILED, interrupted → CANCELED. waiting_approval stays
 *   WORKING: the owner approves out of band, and the caller can't supply that input.
 * - `assistant_text` is appended to the task's one reply artifact (`<taskId>:reply`).
 * - `tool_started` / `tool_finished` become WORKING status messages with a data part naming the
 *   tool (never its input: paths and commands don't cross a link).
 * - `usage` is summed into the task's `metadata.usage` and sent on its final status update.
 * - `error`: `auth_required` → AUTH_REQUIRED (interrupted), anything else → FAILED.
 * - Events with no open task (before the first prompt, after a terminal state) project to nothing.
 *
 * Pure and synchronous: feed it events, get back the updates to send. It never touches the
 * AgentEvent stream to phones.
 */
export interface LinkProjectorOptions {
  contextId: string;
  newId?: () => string;
  now?: () => number;
}

export interface LinkUsage {
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}

export const REPLY_ARTIFACT_SUFFIX = ":reply";

export class LinkProjector {
  readonly contextId: string;
  readonly #newId: () => string;
  readonly #now: () => number;
  #task: LinkTask | undefined;
  #usage: LinkUsage | undefined;

  constructor(opts: LinkProjectorOptions) {
    this.contextId = opts.contextId;
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#now = opts.now ?? Date.now;
  }

  /** The current (or last) task, a snapshot. */
  get task(): LinkTask | undefined {
    return this.#task ? structuredClone(this.#task) : undefined;
  }

  /** A new prompt opens a new task (SUBMITTED). An open task is left as is (no implicit cancel). */
  prompt(text: string, opts: { messageId?: string; metadata?: Record<string, unknown> } = {}): LinkStreamResponse[] {
    const id = this.#newId();
    const message: LinkMessage = {
      messageId: opts.messageId ?? this.#newId(),
      contextId: this.contextId,
      taskId: id,
      role: "ROLE_USER",
      parts: [{ text }],
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };
    this.#usage = undefined;
    this.#task = {
      id,
      contextId: this.contextId,
      status: this.#status("TASK_STATE_SUBMITTED"),
      history: [message],
    };
    return [{ task: this.task! }];
  }

  push(e: AdapterEvent): LinkStreamResponse[] {
    const t = this.#task;
    if (!t || isTerminalLinkState(t.status.state)) return [];
    switch (e.type) {
      case "started":
        return [];
      case "state":
        switch (e.state) {
          case "running":
          case "waiting_approval":
            return this.#move("TASK_STATE_WORKING");
          case "waiting_input":
            return this.#move("TASK_STATE_INPUT_REQUIRED");
          case "idle":
          case "completed":
            return this.#move("TASK_STATE_COMPLETED");
          case "failed":
            return this.#move("TASK_STATE_FAILED");
          case "interrupted":
            return this.#move("TASK_STATE_CANCELED");
          case "starting":
            return [];
        }
        return [];
      case "assistant_text":
        return this.#reply(e.text);
      case "tool_started":
        return this.#move("TASK_STATE_WORKING", [
          { data: { tool: { toolUseId: e.toolUseId, toolName: e.toolName, status: "started" } } },
        ]);
      case "tool_finished":
        return this.#move("TASK_STATE_WORKING", [
          { data: { tool: { toolUseId: e.toolUseId, status: e.ok ? "ok" : "failed" } } },
        ]);
      case "usage": {
        const u = this.#usage ?? { tokIn: 0, tokOut: 0, tokCacheRead: 0, tokCacheWrite: 0 };
        this.#usage = {
          tokIn: u.tokIn + e.tokIn,
          tokOut: u.tokOut + e.tokOut,
          tokCacheRead: u.tokCacheRead + e.tokCacheRead,
          tokCacheWrite: u.tokCacheWrite + e.tokCacheWrite,
        };
        t.metadata = { ...t.metadata, usage: { ...this.#usage } };
        return [];
      }
      case "error":
        return this.#move(e.code === "auth_required" ? "TASK_STATE_AUTH_REQUIRED" : "TASK_STATE_FAILED", [
          { data: { error: { code: e.code } } },
        ]);
    }
  }

  #status(state: LinkTaskState, parts?: LinkPart[]): LinkTaskStatus {
    const timestamp = new Date(this.#now()).toISOString();
    if (!parts || !this.#task) return { state, timestamp };
    const message: LinkMessage = {
      messageId: this.#newId(),
      contextId: this.contextId,
      taskId: this.#task.id,
      role: "ROLE_AGENT",
      parts,
    };
    return { state, message, timestamp };
  }

  /** Moves the open task; a repeated state with no message sends nothing. */
  #move(state: LinkTaskState, parts?: LinkPart[]): LinkStreamResponse[] {
    const t = this.#task!;
    if (t.status.state === state && !parts) return [];
    t.status = this.#status(state, parts);
    const terminal = isTerminalLinkState(state);
    const usage = terminal && t.metadata?.usage !== undefined ? { metadata: { usage: t.metadata.usage } } : {};
    return [
      {
        statusUpdate: { taskId: t.id, contextId: this.contextId, status: structuredClone(t.status), ...usage },
      },
    ];
  }

  #reply(text: string): LinkStreamResponse[] {
    const t = this.#task!;
    const artifacts = (t.artifacts ??= []);
    const artifactId = `${t.id}${REPLY_ARTIFACT_SUFFIX}`;
    const part: LinkPart = { text };
    const existing: LinkArtifact | undefined = artifacts.find((a) => a.artifactId === artifactId);
    if (existing) existing.parts.push(part);
    else artifacts.push({ artifactId, name: "reply", parts: [part] });
    const out: LinkStreamResponse[] = this.#move("TASK_STATE_WORKING");
    out.push({
      artifactUpdate: {
        taskId: t.id,
        contextId: this.contextId,
        artifact: { artifactId, name: "reply", parts: [part] },
        // Canonical ProtoJSON: `false` is omitted. The end of the reply is the terminal status.
        ...(existing ? { append: true } : {}),
      },
    });
    return out;
  }
}
