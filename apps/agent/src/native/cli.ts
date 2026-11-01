import { connect } from "node:net";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { sessionLink } from "@chalito/protocol";
import { openRpc } from "../code/cli.js";
import { CODE_MAX_LINE } from "../code/server.js";
import {
  nativeHookInput,
  nativeHookOutput,
  type NativeHookReply,
  type NativeHookRequest,
  type NativeProvider,
} from "./protocol.js";

const HOOK_MAX = 64 * 1024;
// Read past the hook limit only to learn the folder: oversized requests outside workspaces still pass.
const READ_MAX = 1024 * 1024;

const read = (input: NodeJS.ReadableStream): Promise<{ text: string; bytes: number }> =>
  new Promise((resolve) => {
    let text = "";
    let bytes = 0;
    const finish = (value: string) => {
      clearTimeout(timer);
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", error);
      input.pause();
      resolve({ text: value, bytes });
    };
    const data = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > READ_MAX) finish("");
      else text += chunk.toString();
    };
    const end = () => finish(text);
    const error = () => finish("");
    const timer = setTimeout(() => finish(""), 1000);
    input.on("data", data);
    input.once("end", end);
    input.once("error", error);
  });

const cwdOf = (raw: string): string | undefined => {
  try {
    const h = JSON.parse(raw) as { cwd?: unknown; workspace_roots?: unknown };
    const cwd = h.cwd ?? (Array.isArray(h.workspace_roots) ? h.workspace_roots[0] : undefined);
    return typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
};

const REASON = /^[a-z_]{1,40}$/;

/** Runs inside the native app's hook process. It never calls a model or opens provider credentials. */
export const runNativeHook = async (
  io: {
    input: NodeJS.ReadableStream;
    out(text: string): void;
    openPipe?: () => { ok: true; stream: Duplex } | { ok: false };
    connect?: (path: string) => Duplex;
    /** The agent's workspace list on disk, consulted only when the agent can't answer. */
    workspaceStatus?: (cwd: string) => "inside" | "outside" | "unknown";
  },
  path: string | null,
  provider: NativeProvider,
  event: string,
  locale: "es" | "en",
  limits: { connectMs?: number; requestMs?: number } = {},
): Promise<number> => {
  // Without the agent: deny in a workspace (or when unsure), stay out of the way elsewhere.
  const fallback = (cwd: string | undefined, reason: string): NativeHookReply =>
    cwd && (io.workspaceStatus?.(cwd) ?? "unknown") === "outside" ? { ok: true, pass: true } : { ok: false, reason };
  const raw = await read(io.input);
  let reply: NativeHookReply;
  let request: NativeHookRequest | null = null;
  if (raw.bytes > HOOK_MAX) reply = fallback(cwdOf(raw.text), "too_large");
  else if (!(request = nativeHookInput(provider, event, raw.text))) reply = fallback(cwdOf(raw.text), "bad_input");
  else if (JSON.stringify({ id: 1, method: "native", params: request }).length > CODE_MAX_LINE - 64)
    reply = fallback(request.cwd, "too_large");
  else reply = path ? await ask(io, path, request, locale, limits) : { ok: false, reason: "not_running" };
  if (request && !reply.ok && reply.reason === "not_running") reply = fallback(request.cwd, "not_running");
  io.out(`${JSON.stringify(nativeHookOutput(provider, event, reply, locale))}\n`);
  return 0;
};

const ask = async (
  io: Parameters<typeof runNativeHook>[0],
  path: string,
  request: NativeHookRequest,
  locale: "es" | "en",
  limits: { connectMs?: number; requestMs?: number },
): Promise<NativeHookReply> => {
  let socket: Duplex | null = null;
  try {
    if (io.openPipe) {
      const opened = io.openPipe();
      if (opened.ok) socket = opened.stream;
    } else
      socket = await new Promise<Duplex | null>((resolve) => {
        const stream = (io.connect ?? connect)(path);
        const timer = setTimeout(() => {
          stream.destroy();
          resolve(null);
        }, limits.connectMs ?? 2000);
        stream.once("connect", () => {
          clearTimeout(timer);
          resolve(stream);
        });
        stream.once("error", () => {
          clearTimeout(timer);
          stream.destroy();
          resolve(null);
        });
      });
    if (!socket) return { ok: false, reason: "not_running" };
    const rpc = openRpc(
      socket,
      () => undefined,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        rpc.call("native", request),
        new Promise<{ ok: false; error: "timeout" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false, error: "timeout" }),
            limits.requestMs ?? (request.event === "permission" || request.event === "tool" ? 540_000 : 2000),
          );
        }),
      ]);
      if (response.ok && "result" in response && response.result && typeof response.result === "object") {
        const result = response.result as NativeHookReply;
        return {
          ok: result.ok === true,
          allow: result.allow === true,
          pass: result.pass === true,
          ...(typeof result.reason === "string" && REASON.test(result.reason) ? { reason: result.reason } : {}),
          ...(typeof result.sid === "string" ? { sid: result.sid, url: sessionLink(result.sid, locale) } : {}),
        };
      }
      // The agent closed the connection (it stopped) or never answered.
      return {
        ok: false,
        reason:
          response.error === "closed" ? "not_running" : response.error === "timeout" ? "timeout_deny" : "unavailable",
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      rpc.close();
      socket.destroy();
    }
  } catch {
    socket?.destroy();
    return { ok: false, reason: "not_running" };
  }
};
