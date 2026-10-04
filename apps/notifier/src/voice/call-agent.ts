import type { NotifierDeps } from "../executor.js";
import { handleCallTool, type CallContext } from "./call-session.js";

/** The slice of a WebSocket the agent needs (ws in production, a fake in tests). */
export interface CallSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}
export type CallSocketFactory = (url: string, headers: Record<string, string>) => CallSocket;

/**
 * Follows one accepted call over its server WebSocket: starts the companion talking, runs each
 * function call through handleCallTool and returns its output. Resolves when the socket closes.
 */
export const runCallAgent = (deps: NotifierDeps, socket: CallSocket, ctx: CallContext): Promise<void> =>
  new Promise((resolve) => {
    socket.onOpen(() => socket.send(JSON.stringify({ type: "response.create" })));
    socket.onMessage(async (raw) => {
      let ev: { type?: string; call_id?: string; name?: string; arguments?: string };
      try {
        ev = JSON.parse(raw) as typeof ev;
      } catch {
        return;
      }
      if (ev.type !== "response.function_call_arguments.done" || !ev.call_id || !ev.name) return;
      let output: string;
      try {
        output = await handleCallTool(deps, ctx, ev.name, ev.arguments ?? "{}");
      } catch (err) {
        deps.log.error("voice.tool_failed", { name: ev.name, error: err instanceof Error ? err.message : "error" });
        output = JSON.stringify({ ok: false, error: "failed" });
      }
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: ev.call_id, output },
        }),
      );
      socket.send(JSON.stringify({ type: "response.create" }));
    });
    socket.onClose(() => resolve());
  });
