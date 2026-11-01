import type { EmotionTag } from "@chalito/protocol";

/** What the native side says about the USB connection (board.rs BoardStatus). */
export type BoardStatus =
  | { state: "absent" }
  | { state: "connected"; port: string }
  | { state: "permission"; port: string }
  | { state: "error"; port: string; message: string };

/** The native serial link, behind an interface so tests use a fake board. */
export interface BoardPort {
  status(): Promise<BoardStatus>;
  /** One JSON line; rejects when no board is connected. */
  write(line: string): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  onStatus(cb: (status: BoardStatus) => void): () => void;
}

export interface BoardHello {
  fw: string;
  board: string;
  w: number;
  h: number;
  /** The stored card's key, or null when it shows the built-in chalito. */
  card: string | null;
  /** The paired host's key id (first 16 hex of sha256(secret)), or null when it isn't paired. */
  pair: string | null;
}

export type BoardMood = "neutral" | "happy" | "surprised" | "tired" | "sad";
export type BoardAlert = "info" | "attention" | "danger";
export type BoardActivityHint = "working" | "idle";

/** Board → host messages the link itself handles (approval commands are validated elsewhere). */
export type BoardMessage =
  | ({ type: "hello" } & BoardHello)
  | { type: "pet"; trick: string }
  | { type: "card-progress"; key: string; frame: string; offset: number }
  | { type: "card-ack"; key: string; ok: boolean; reason?: string }
  | { type: "pair-ok"; pair: string }
  | { type: "pair-cancel" }
  | { type: "pair-cleared" }
  | { type: "other"; raw: Record<string, unknown> };

const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A line from the board as a message, or null for anything that isn't one (logs, junk, other versions). */
export const parseBoardLine = (line: string): BoardMessage | null => {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.v !== 1 || !str(o.type)) return null;
  switch (o.type) {
    case "hello":
      if (!str(o.fw) || !str(o.board) || !int(o.w) || !int(o.h) || !(o.card === null || str(o.card))) return null;
      // A board without `pair` (older firmware) counts as unpaired.
      return {
        type: "hello",
        fw: o.fw,
        board: o.board,
        w: o.w,
        h: o.h,
        card: o.card,
        pair: str(o.pair) ? o.pair : null,
      };
    case "pair-ok":
      return str(o.pair) ? { type: "pair-ok", pair: o.pair } : null;
    case "pair-cancel":
      return { type: "pair-cancel" };
    case "pair-cleared":
      return { type: "pair-cleared" };
    case "pet":
      return str(o.trick) ? { type: "pet", trick: o.trick } : null;
    case "card-progress":
      return str(o.key) && str(o.frame) && int(o.offset)
        ? { type: "card-progress", key: o.key, frame: o.frame, offset: o.offset }
        : null;
    case "card-ack":
      if (!str(o.key) || typeof o.ok !== "boolean") return null;
      return { type: "card-ack", key: o.key, ok: o.ok, ...(str(o.reason) ? { reason: o.reason } : {}) };
    default:
      return { type: "other", raw: o };
  }
};

/** The pet's emotion as one of the five faces the board draws. */
export const boardMood = (tag: EmotionTag): BoardMood => {
  switch (tag) {
    case "happy":
    case "excited":
    case "relaxed":
      return "happy";
    case "surprised":
      return "surprised";
    case "tired":
      return "tired";
    case "sad":
    case "worried":
      return "sad";
    default:
      return "neutral";
  }
};

/** BOARD_LINK: `ms` is 1–60000. */
export const clampMs = (ms: number) => Math.min(60_000, Math.max(1, Math.round(ms)));

/** BOARD_LINK host hello: the board has no clock, so it learns the time and the local offset here. */
// `0 -` keeps UTC at 0, not -0 (which JSON turns into 0 and a strict compare tells apart).
export const hostHello = (at = new Date()) => ({
  v: 1,
  type: "hello",
  now: at.getTime(),
  tz: 0 - at.getTimezoneOffset(),
});
