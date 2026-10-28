import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { ledgerPath, watchEnabled, type WatchPaths } from "./watcher.js";

// The Codex hook (`chalito watch-hook codex`), adapted from Alux's pet/hooks/codex-event.mjs by Omar (homiomar).
// It prints nothing and always exits 0, so Codex's own decision flow is untouched.

const MAX_INPUT = 64 * 1024;
const ROTATE_AT = 1024 * 1024;

/** A Codex hook payload → the ledger line, or null for anything that isn't a top-level approval or tool run. */
export const hookLine = (raw: string, nowMs: number): string | null => {
  let h: Record<string, unknown>;
  try {
    const d: unknown = JSON.parse(raw || "{}");
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    h = d as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const session = s(h.session_id) ?? s(h.thread_id) ?? s(h.conversation_id);
  // Subagent threads are not the person's to answer.
  if (!session || h.agent_type) return null;
  const name = s(h.hook_event_name);
  const tool = s(h.tool_name);
  const event =
    name === "PermissionRequest"
      ? { event: "notify", ...(tool ? { tool: tool.slice(0, 40) } : {}) }
      : name === "PostToolUse"
        ? { event: "tool" }
        : null;
  if (!event) return null;
  const cwd = s(h.cwd);
  return JSON.stringify({ session: session.slice(0, 128), ts: nowMs, ...event, ...(cwd ? { cwd } : {}) });
};

/** Appends to Chalito's own ledger, and only while the person has the watch turned on. */
export const recordHook = (raw: string, paths: Pick<WatchPaths, "own">, nowMs: number): boolean => {
  if (!watchEnabled(paths)) return false;
  const line = hookLine(raw, nowMs);
  if (!line) return false;
  const file = ledgerPath(paths);
  mkdirSync(paths.own, { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > ROTATE_AT) renameSync(file, `${file}.1`);
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e;
  }
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
  return true;
};

/** Reads the payload from stdin, giving up after a second so Codex is never held up. */
export const readHookInput = (input: NodeJS.ReadableStream, timeoutMs = 1000): Promise<string> =>
  new Promise((resolve) => {
    let raw = "";
    const done = () => {
      clearTimeout(timer);
      resolve(raw.slice(0, MAX_INPUT));
    };
    const timer = setTimeout(done, timeoutMs);
    input.on("data", (c: Buffer | string) => {
      if (raw.length < MAX_INPUT) raw += c.toString();
    });
    input.on("end", done);
    input.on("error", done);
  });
