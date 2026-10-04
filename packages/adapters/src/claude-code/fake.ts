import type {
  CanUseTool,
  HookCallbackMatcher,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn, QueryLike } from "./adapter.js";

/**
 * Fake Claude Code: a scripted stand-in for the SDK's query() that follows the SDK's
 * permission order for each tool call: PreToolUse hooks first (deny wins), then the
 * permission mode, then canUseTool for anything not decided (and always for
 * AskUserQuestion). Used by the adapter and agent tests.
 */
export type FakeStep = { say: string } | { tool: string; input: Record<string, unknown> };

export interface FakeRun {
  /** Tool calls that actually "ran". */
  ran: { tool: string; input: Record<string, unknown> }[];
  /** Tool calls refused. */
  refused: { tool: string; reason: string }[];
  options?: Options;
  modes: string[];
  interrupted: number;
}

export const fakeClaudeCode = (
  turns: FakeStep[][],
  run: FakeRun = { ran: [], refused: [], modes: [], interrupted: 0 },
): { queryFn: QueryFn; run: FakeRun } => {
  const queryFn: QueryFn = ({ prompt, options }) => {
    run.options = options;
    run.modes.push(String(options.permissionMode));
    let aborter = new AbortController();
    let n = 0;
    const hooks = (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[];
    const canUseTool = options.canUseTool as CanUseTool | undefined;

    async function* gen(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "fake-session-1" } as unknown as SDKMessage;
      let turn = 0;
      for await (const _msg of prompt as AsyncIterable<SDKUserMessage>) {
        const steps = turns[turn++] ?? [];
        aborter = new AbortController();
        for (const step of steps) {
          if (aborter.signal.aborted) break;
          if ("say" in step) {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: step.say }] },
            } as unknown as SDKMessage;
            continue;
          }
          const id = `toolu_${++n}`;
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id, name: step.tool, input: step.input }] },
          } as unknown as SDKMessage;
          let decision: string | undefined;
          let reason = "";
          let input = step.input;
          for (const m of hooks) {
            for (const h of m.hooks) {
              const out = (await h(
                {
                  hook_event_name: "PreToolUse",
                  tool_name: step.tool,
                  tool_input: input,
                  tool_use_id: id,
                  session_id: "fake-session-1",
                  cwd: options.cwd ?? "",
                  transcript_path: "",
                } as never,
                id,
                { signal: aborter.signal },
              )) as {
                hookSpecificOutput?: {
                  permissionDecision?: string;
                  permissionDecisionReason?: string;
                  updatedInput?: Record<string, unknown>;
                };
              };
              const d = out.hookSpecificOutput?.permissionDecision;
              if (d === "deny" || (d && !decision)) {
                decision = d;
                reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
              }
              if (out.hookSpecificOutput?.updatedInput) input = out.hookSpecificOutput.updatedInput;
            }
          }
          let allowed = decision === "allow";
          if (decision === "deny") allowed = false;
          if (step.tool === "AskUserQuestion" || decision === undefined || decision === "ask") {
            if (decision !== "deny") {
              const res = canUseTool
                ? await canUseTool(step.tool, input, { signal: aborter.signal, toolUseID: id, requestId: id } as never)
                : { behavior: "deny" as const, message: "no canUseTool" };
              allowed = res?.behavior === "allow";
              if (res?.behavior === "allow" && res.updatedInput) input = res.updatedInput;
              if (res?.behavior === "deny") reason = res.message;
            }
          }
          if (allowed) run.ran.push({ tool: step.tool, input });
          else run.refused.push({ tool: step.tool, reason });
          yield {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !allowed }] },
          } as unknown as SDKMessage;
        }
        yield {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } as unknown as SDKMessage;
      }
    }

    const it = gen();
    const q: QueryLike = {
      [Symbol.asyncIterator]: () => it,
      interrupt: async () => {
        run.interrupted++;
        aborter.abort();
      },
      setPermissionMode: async (mode) => {
        run.modes.push(mode);
      },
    };
    return q;
  };
  return { queryFn, run };
};
