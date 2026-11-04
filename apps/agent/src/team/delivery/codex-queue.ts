import { execFile } from "node:child_process";
import { channelNotifications } from "./mcp-channel.js";
import type { DeliveryFactory, TeamBatch } from "./types.js";

export const CODEX_QUEUE = "codex-queue";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Linux caps one argv string at 128 KiB (bytes, so multibyte text counts more): headroom for the flag prefix. */
const MAX_BYTES = 120_000;

// Only a session that named its own thread is pushed; a thread is never picked from a list by folder or recency.
export const codexQueue: DeliveryFactory = {
  id: CODEX_QUEUE,
  select: ({ provider, client, link }) =>
    provider === "codex" && link && client.codexThread
      ? {
          id: CODEX_QUEUE,
          canWake: true,
          // `codex queue` exiting 0 means queued, not seen: the hub keeps these unread until team_read.
          ackOnRead: true,
          deliver: (batch) => link.push({ teamDelivery: { adapter: CODEX_QUEUE, batch } }),
        }
      : null,
};

const uuid = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);

const pick = (o: unknown): string | null => {
  if (typeof o === "string") {
    try {
      return pick(JSON.parse(o));
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  return uuid(r.thread_id) ?? uuid(r.threadId) ?? uuid(r.session_id) ?? uuid(r.sessionId);
};

/** The calling Codex thread, from a tools/call `_meta` (top level or Codex's turn metadata); null when absent. */
export const codexThreadFrom = (meta: unknown): string | null => {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  return pick(m) ?? pick(m["x-codex-turn-metadata"]) ?? pick(m["codex/turn"]);
};

export const envThread = (value: string | undefined): string | null => uuid(value);

/** The next user turn: Claude's quoted, tag-free framing, each message tagged with its seq so team_read can dedupe.
 *  Null when it would not fit one argument: never cut, the batch then waits for team_read whole. */
export const queueText = (batch: TeamBatch): string | null => {
  const text = channelNotifications(batch)
    .map((n, i) => `[Chalito team seq ${batch.messages[i]!.seq}]\n${(n.params as { content: string }).content}`)
    .join("\n\n");
  return Buffer.byteLength(text, "utf8") > MAX_BYTES ? null : text;
};

// No --resume: the owning session takes the message, never a competing turn. `=` keeps text starting with "-" a value.
export const queueArgs = (thread: string, text: string): string[] => [
  "queue",
  `--thread=${thread}`,
  `--message=${text}`,
];

/** ok: queued. unknown: it may have been queued (timed out), so it is neither retried nor flagged. */
export type QueueOutcome = { ok: true } | { ok: false; unknown?: boolean; reason: string };
export type QueueRunner = (thread: string, text: string) => Promise<QueueOutcome>;

export const runCodexQueue: QueueRunner = (thread, text) =>
  new Promise((resolve) => {
    try {
      execFile("codex", queueArgs(thread, text), { timeout: 15_000 }, (err, _out, stderr) => {
        if (!err) return resolve({ ok: true });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (e.killed) return resolve({ ok: false, unknown: true, reason: "timed out after 15s" });
        const detail = String(stderr ?? "")
          .trim()
          .split("\n")[0]
          ?.slice(0, 200);
        resolve({ ok: false, reason: `${e.code ?? "error"}${detail ? `: ${detail}` : ""}` });
      });
    } catch (err) {
      // A spawn can throw synchronously (E2BIG); never let it reject the delivery chain.
      resolve({ ok: false, reason: (err as NodeJS.ErrnoException).code ?? "spawn failed" });
    }
  });
