import { connect } from "node:net";
import { homedir } from "node:os";
import type { Duplex } from "node:stream";
import { sessionLink } from "@chalito/protocol";
import { openRpc } from "../code/cli.js";
import { CODE_MAX_LINE } from "../code/server.js";
import {
  nativeHookInput,
  nativeHookOutput,
  nativeTargetFields,
  nativeTargets,
  type NativeTargetFields,
  type NativeHookReply,
  type NativeHookRequest,
  type NativeProvider,
} from "./protocol.js";

const HOOK_MAX = 64 * 1024;
// Read past the hook limit only to learn the folder: oversized requests outside workspaces still pass.
const READ_MAX = 1024 * 1024;
// Past READ_MAX only the head is kept: the target fields come first in every vendor's payload.
const HEAD_MAX = 16 * 1024;
const IDLE_MS = 1000;

/** Stdin up to READ_MAX, or its first HEAD_MAX when larger; a stalled writer ends the read after IDLE_MS. */
export const readHookStdin = (
  input: NodeJS.ReadableStream,
  idleMs = IDLE_MS,
): Promise<{ text: string; bytes: number }> =>
  new Promise((resolve) => {
    let text = "";
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      input.removeListener("data", data);
      input.removeListener("end", finish);
      input.removeListener("error", finish);
      input.pause();
      resolve({ text: bytes > READ_MAX ? text.slice(0, HEAD_MAX) : text, bytes });
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    };
    const data = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (text.length < READ_MAX) text += chunk.toString();
      if (bytes > READ_MAX) finish();
      else idle();
    };
    idle();
    input.on("data", data);
    input.once("end", finish);
    input.once("error", finish);
  });

const REASON = /^[a-z_]{1,40}$/;
const fieldsOf = (r: NativeHookRequest): NativeTargetFields => ({
  cwd: r.cwd,
  roots: r.workspaceRoots,
  input: r.input,
});

/** Runs inside the native app's hook process. It never calls a model or opens provider credentials. */
export const runNativeHook = async (
  io: {
    input: NodeJS.ReadableStream;
    out(text: string): void;
    openPipe?: () => { ok: true; stream: Duplex } | { ok: false };
    connect?: (path: string) => Duplex;
    /** The agent's workspace list on disk, consulted only when the agent can't answer. */
    workspaceStatus?: (cwd: string) => "inside" | "outside" | "unknown";
    /** Expands `~` in request paths. */
    home?: string;
  },
  path: string | null,
  provider: NativeProvider,
  event: string,
  locale: "es" | "en",
  limits: { connectMs?: number; requestMs?: number; idleMs?: number } = {},
): Promise<number> => {
  // Without the agent: deny if any target is in a workspace (or unsure), stay out of the way elsewhere.
  const fallback = (fields: NativeTargetFields, reason: string): NativeHookReply => {
    const targets = nativeTargets(fields, io.home ?? homedir());
    const outside = !!targets?.length && targets.every((t) => (io.workspaceStatus?.(t) ?? "unknown") === "outside");
    return outside ? { ok: true, pass: true } : { ok: false, reason };
  };
  const raw = await readHookStdin(io.input, limits.idleMs);
  let reply: NativeHookReply;
  let request: NativeHookRequest | null = null;
  // A cut-off payload may name its file after the part we kept: pass only when a file target was read.
  if (raw.bytes > READ_MAX && !/"(file_path|path|notebook_path)"\s*:/.test(raw.text))
    reply = { ok: false, reason: "too_large" };
  else if (raw.bytes > HOOK_MAX) reply = fallback(nativeTargetFields(raw.text), "too_large");
  else if (!(request = nativeHookInput(provider, event, raw.text)))
    reply = fallback(nativeTargetFields(raw.text), "bad_input");
  else if (JSON.stringify({ id: 1, method: "native", params: request }).length > CODE_MAX_LINE - 64)
    reply = fallback(fieldsOf(request), "too_large");
  else reply = path ? await ask(io, path, request, locale, limits) : { ok: false, reason: "not_running" };
  if (request && !reply.ok && reply.reason === "not_running") reply = fallback(fieldsOf(request), "not_running");
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
