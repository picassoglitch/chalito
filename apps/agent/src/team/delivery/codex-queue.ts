import { execFile } from "node:child_process";
import { channelNotifications } from "./mcp-channel.js";
import type { DeliveryFactory, TeamBatch } from "./types.js";

export const CODEX_QUEUE = "codex-queue";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Linux caps one argv string at 128 KiB; a batch is at most 8 capped messages, well under this. */
const MAX_TEXT = 100_000;

// Only a session that named its own thread is pushed; a thread is never picked from a list by folder or recency.
export const codexQueue: DeliveryFactory = {
  id: CODEX_QUEUE,
  select: ({ provider, client, link }) =>
    provider === "codex" && link && client.codexThread
      ? {
          id: CODEX_QUEUE,
          canWake: true,
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

/** The text queued as the next user turn: the same quoted, tag-free framing Claude's channel gets. */
export const queueText = (batch: TeamBatch): string => {
  const text = channelNotifications(batch)
    .map((n) => (n.params as { content: string }).content)
    .join("\n\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut: call team_read for the rest]` : text;
};

// No --resume: the owning session takes the message, never a competing turn. `=` keeps text starting with "-" a value.
export const queueArgs = (thread: string, text: string): string[] => [
  "queue",
  `--thread=${thread}`,
  `--message=${text}`,
];

export type QueueRunner = (thread: string, text: string) => Promise<boolean>;

export const runCodexQueue: QueueRunner = (thread, text) =>
  new Promise((resolve) => {
    execFile("codex", queueArgs(thread, text), { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
  });
