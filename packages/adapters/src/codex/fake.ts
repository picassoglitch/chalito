import { InputQueue } from "../core.js";
import { HARDENING_OVERRIDES, type CodexSpawn, type CodexTransport } from "./adapter.js";

/**
 * Fake `codex app-server`: a scripted stand-in that speaks the same JSONL protocol (no "jsonrpc"
 * field) over an in-process transport. Like the real server, a tool item starts, then (if the
 * step needs approval) the server asks the client and only runs it on `accept`. Used by the
 * adapter, conformance and agent tests.
 */
export type FakeCodexStep =
  | { say: string }
  | { command: string; cwd?: string; approval?: boolean }
  | { edit: string | string[]; approval?: boolean }
  | { ask: { id: string; question: string; header?: string; options: string[] }[] };

export interface FakeCodexRun {
  spawned?: { command: string; args: string[]; env: Record<string, string | undefined>; cwd: string };
  /** `approvalPolicy` of every thread/start|resume and turn/start. */
  policies: unknown[];
  /** Every message the client sent, in order. */
  received: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }[];
  /** Tool items that actually "ran". */
  ran: { tool: string; input: Record<string, unknown> }[];
  /** Tool items the client declined. */
  refused: { tool: string; input: Record<string, unknown> }[];
  /** Raw approval decisions the client sent. */
  decisions: unknown[];
  /** Answers to item/tool/requestUserInput, keyed by question id. */
  answers: Record<string, { answers: string[] }>[];
  /** `sandbox` from thread/start|resume and `sandboxPolicy` from each turn/start. */
  sandboxes: unknown[];
  interrupted: number;
  /** Protocol violations the fake detected (requests before initialize, unknown methods). */
  violations: string[];
}

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };

export const fakeCodex = (
  turns: FakeCodexStep[][],
  run: FakeCodexRun = {
    received: [],
    ran: [],
    refused: [],
    decisions: [],
    answers: [],
    policies: [],
    sandboxes: [],
    interrupted: 0,
    violations: [],
  },
  options: {
    /** What initialize reports; the adapter checks the version in it. */
    userAgent?: string;
    /** MCP servers the effective config defines (system, admin or cloud layers, plugins). */
    mcpServers?: string[];
  } = {},
): { spawn: CodexSpawn; run: FakeCodexRun } => {
  const userAgent = options.userAgent ?? "chalito/0.162.0 (Ubuntu 24.4.0; x86_64) xterm-256color (chalito; 0.0.0)";
  const spawn: CodexSpawn = (command, args, env, cwd) => {
    run.spawned = { command, args, env, cwd };
    // Every hardening override must be on the command line as `-c <override>`.
    for (const o of HARDENING_OVERRIDES) {
      const i = args.indexOf(o);
      if (i < 1 || args[i - 1] !== "-c") run.violations.push(`missing -c ${o}`);
    }
    let mcpChecked = false;
    const out = new InputQueue<string>();
    const emit = (m: Msg) => out.push(JSON.stringify(m));
    const waiting = new Map<number | string, (result: unknown) => void>();
    let serverId = 100;
    let initialized = false;
    let turnN = 0;
    let itemN = 0;
    const threadId = "thr_fake_1";
    let current: { id: string; aborted: boolean } | null = null;

    const ask = (method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        const id = serverId++;
        waiting.set(id, resolve);
        emit({ id, method, params });
      });

    const runTurn = async (turn: { id: string; aborted: boolean }, steps: FakeCodexStep[]) => {
      const base = { threadId, turnId: turn.id };
      emit({
        method: "turn/started",
        params: { threadId, turn: { id: turn.id, items: [], status: "inProgress", error: null } },
      });
      for (const step of steps) {
        if (turn.aborted) break;
        const itemId = `item_${++itemN}`;
        if ("say" in step) {
          const half = Math.ceil(step.say.length / 2);
          emit({ method: "item/started", params: { ...base, item: { type: "agentMessage", id: itemId, text: "" } } });
          for (const delta of [step.say.slice(0, half), step.say.slice(half)])
            emit({ method: "item/agentMessage/delta", params: { ...base, itemId, delta } });
          emit({
            method: "item/completed",
            params: { ...base, item: { type: "agentMessage", id: itemId, text: step.say } },
          });
          continue;
        }
        if ("ask" in step) {
          const res = (await ask("item/tool/requestUserInput", {
            ...base,
            itemId,
            isBlocking: true,
            autoResolutionMs: null,
            questions: step.ask.map((q) => ({
              id: q.id,
              header: q.header ?? "",
              question: q.question,
              isOther: false,
              isSecret: false,
              options: q.options.map((label) => ({ label, description: "" })),
            })),
          })) as { answers?: Record<string, { answers: string[] }> } | undefined;
          run.answers.push(res?.answers ?? {});
          continue;
        }
        const isCommand = "command" in step;
        const tool = isCommand ? "Bash" : "Edit";
        const paths = isCommand ? [] : Array.isArray(step.edit) ? step.edit : [step.edit];
        const cwd = isCommand ? (step.cwd ?? "/ws") : undefined;
        const input = isCommand ? { command: step.command, cwd } : { file_path: paths[0], paths };
        const item = isCommand
          ? {
              type: "commandExecution",
              id: itemId,
              command: step.command,
              cwd,
              status: "inProgress",
              commandActions: [],
            }
          : {
              type: "fileChange",
              id: itemId,
              status: "inProgress",
              changes: paths.map((path) => ({ path, kind: { type: "update", move_path: null }, diff: "" })),
            };
        emit({ method: "item/started", params: { ...base, item, startedAtMs: 0 } });
        let ok = true;
        if (step.approval ?? true) {
          const res = (await ask(
            isCommand ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval",
            isCommand
              ? { ...base, itemId, kind: "command", startedAtMs: 0, environmentId: null, command: step.command, cwd }
              : { ...base, itemId, startedAtMs: 0, reason: null, grantRoot: null },
          )) as { decision?: unknown } | undefined;
          run.decisions.push(res?.decision);
          emit({ method: "serverRequest/resolved", params: { threadId, requestId: serverId - 1 } });
          ok = res?.decision === "accept" || res?.decision === "acceptForSession";
        }
        (ok ? run.ran : run.refused).push({ tool, input });
        emit({
          method: "item/completed",
          params: { ...base, item: { ...item, status: ok ? "completed" : "declined" }, completedAtMs: 0 },
        });
      }
      const usage = {
        totalTokens: 130,
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      };
      emit({
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId: turn.id, tokenUsage: { total: usage, last: usage, modelContextWindow: null } },
      });
      if (current === turn) current = null;
      emit({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turn.id, items: [], status: turn.aborted ? "interrupted" : "completed", error: null },
        },
      });
    };

    const onRequest = (m: Msg & { id: number | string; method: string }) => {
      const p = m.params ?? {};
      if (!initialized && m.method !== "initialize") run.violations.push(`${m.method} before initialize`);
      switch (m.method) {
        case "initialize":
          return emit({
            id: m.id,
            result: {
              userAgent,
              codexHome: "/home/u/.codex",
              platformFamily: "unix",
              platformOs: "linux",
            },
          });
        case "account/login/start":
          if (p.type !== "apiKey") run.violations.push(`login type ${String(p.type)}`);
          return emit({ id: m.id, result: { type: p.type } });
        case "thread/start":
        case "thread/resume":
          run.sandboxes.push(p.sandbox);
          run.policies.push(p.approvalPolicy);
          if (p.approvalPolicy !== "untrusted")
            run.violations.push(`approvalPolicy ${JSON.stringify(p.approvalPolicy)}`);
          // Real app-server auto-trusts the project (loading its .codex rules and hooks) when
          // thread/start carries a cwd the sandbox can write.
          if (m.method === "thread/start" && p.cwd !== undefined) run.violations.push("thread/start with cwd");
          return emit({
            id: m.id,
            result: { thread: { id: m.method === "thread/resume" ? p.threadId : threadId, turns: [] } },
          });
        case "mcpServerStatus/list":
          if (p.threadId === undefined) run.violations.push("mcpServerStatus/list without threadId");
          mcpChecked = true;
          return emit({
            id: m.id,
            result: { data: (options.mcpServers ?? []).map((name) => ({ name, tools: {} })), nextCursor: null },
          });
        case "turn/start": {
          if (!mcpChecked) run.violations.push("turn/start before the MCP server check");
          run.sandboxes.push(p.sandboxPolicy);
          run.policies.push(p.approvalPolicy);
          if (p.approvalPolicy !== "untrusted")
            run.violations.push(`approvalPolicy ${JSON.stringify(p.approvalPolicy)}`);
          const turn = { id: `turn_${++turnN}`, aborted: false };
          current = turn;
          emit({ id: m.id, result: { turn: { id: turn.id, items: [], status: "inProgress", error: null } } });
          void runTurn(turn, turns[turnN - 1] ?? []);
          return;
        }
        case "turn/interrupt":
          run.interrupted++;
          if (current && current.id === p.turnId) current.aborted = true;
          return emit({ id: m.id, result: {} });
        default:
          run.violations.push(`unknown method ${m.method}`);
          return emit({ id: m.id, error: { code: -32601, message: "method not found" } } as Msg);
      }
    };

    const transport: CodexTransport = {
      send: (line) => {
        const m = JSON.parse(line) as Msg;
        run.received.push(m);
        if ("jsonrpc" in m) run.violations.push("jsonrpc field on the wire");
        if (m.method !== undefined && m.id !== undefined) onRequest(m as Msg & { id: number | string; method: string });
        else if (m.method === "initialized") initialized = true;
        else if (m.method === undefined && m.id !== undefined) {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          w?.(m.result);
        }
      },
      lines: out,
      close: () => {
        for (const w of waiting.values()) w(undefined);
        waiting.clear();
        out.close();
      },
    };
    return transport;
  };
  return { spawn, run };
};
