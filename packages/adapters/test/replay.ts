import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { InputQueue } from "../src/core.js";
import type { CodexSpawn } from "../src/codex/index.js";

/** One line of a recorded app-server session: what the client sent or received. */
export interface TranscriptEntry {
  dir: "send" | "recv";
  msg: Record<string, unknown>;
}

export const loadTranscript = (url: URL): TranscriptEntry[] =>
  readFileSync(url, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptEntry);

/**
 * Replays a transcript as the server. Each run of consecutive `send` lines must be matched
 * exactly (in any order within the run) by what the client writes; then the following `recv`
 * lines are delivered. Anything unexpected is recorded in `mismatches`.
 */
export const replay = (entries: TranscriptEntry[]) => {
  const state = {
    idx: 0,
    mismatches: [] as string[],
    spawned: undefined as { command: string; args: string[] } | undefined,
  };
  let batch: Record<string, unknown>[] = [];
  let out = new InputQueue<string>();

  const deliver = () => {
    while (state.idx < entries.length && entries[state.idx]!.dir === "recv") {
      out.push(JSON.stringify(entries[state.idx]!.msg));
      state.idx++;
    }
    batch = [];
    while (state.idx < entries.length && entries[state.idx]!.dir === "send") batch.push(entries[state.idx++]!.msg);
  };

  const spawn: CodexSpawn = (command, args) => {
    state.spawned = { command, args };
    out = new InputQueue<string>();
    deliver();
    return {
      send: (line) => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const i = batch.findIndex((m) => isDeepStrictEqual(m, msg));
        if (i === -1) {
          state.mismatches.push(
            `unexpected: ${line}\n  expected one of: ${batch.map((m) => JSON.stringify(m)).join(" | ")}`,
          );
          return;
        }
        batch.splice(i, 1);
        // Real I/O is async; deliver the server's next lines on a later tick.
        if (batch.length === 0) setTimeout(deliver, 1);
      },
      lines: out,
      close: () => out.close(),
    };
  };

  return { spawn, state, finished: () => state.idx >= entries.length && batch.length === 0 };
};
