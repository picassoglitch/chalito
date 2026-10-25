import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner } from "../runner.js";
import type { OwnSessionView } from "./own-sessions.js";
import type { WatchPaths } from "./watcher.js";

// "Abrir" for an observed session, after Alux's pet/focus.js by Omar (homiomar): macOS only, best effort.

export type OpenResult = { opened: true; via: "terminal" | "codex" } | { opened: false };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TTY = /^ttys?\d{1,4}$/;

const SELECT_TAB = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          set selected of t to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

/** Claude Code writes sessions/<pid>.json with the sessionId it runs; the file goes when it exits. */
export const claudePid = (dir: string, sessionId: string): number | null => {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, n), "utf8")) as { sessionId?: unknown; pid?: unknown };
      if (s.sessionId === sessionId && typeof s.pid === "number" && Number.isInteger(s.pid) && s.pid > 0) return s.pid;
    } catch {
      // being written, or not one of Claude's
    }
  }
  return null;
};

/** The person clicked "Abrir", so bringing a window forward is theirs to ask; elsewhere the panel shows the folder. */
export const openOwnSession = async (
  s: Pick<OwnSessionView, "source" | "id">,
  deps: { platform: NodeJS.Platform; run: ProcessRunner; paths: Pick<WatchPaths, "claudeSessions"> },
): Promise<OpenResult> => {
  if (deps.platform !== "darwin" || !SAFE_ID.test(s.id)) return { opened: false };
  if (s.source === "codex") {
    const r = await deps.run.run("open", [`codex://threads/${s.id}`]);
    return r.code === 0 ? { opened: true, via: "codex" } : { opened: false };
  }
  const pid = claudePid(deps.paths.claudeSessions, s.id);
  if (pid === null) return { opened: false };
  const ps = await deps.run.run("ps", ["-o", "tty=", "-p", String(pid)]);
  const tty = ps.stdout.trim();
  if (ps.code !== 0 || !TTY.test(tty)) return { opened: false };
  const r = await deps.run.run("osascript", ["-e", SELECT_TAB, `/dev/${tty}`]);
  return r.code === 0 && r.stdout.trim() === "ok" ? { opened: true, via: "terminal" } : { opened: false };
};
