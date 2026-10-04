import type { Level } from "@chalito/protocol";
import type { EscalationItem } from "./types.js";

/** One step of a ladder. A rung above the item's level is skipped. */
export interface Rung {
  afterMs: number;
  channel: "push" | "whatsapp" | "call" | "sms";
  level: Level;
}

const MIN = 60_000;

/** push → re-push → WhatsApp → call → SMS (last rung). */
export const STANDARD_LADDER: readonly Rung[] = [
  { afterMs: 0, channel: "push", level: "L1" },
  { afterMs: 5 * MIN, channel: "push", level: "L2" },
  { afterMs: 10 * MIN, channel: "whatsapp", level: "L3" },
  { afterMs: 15 * MIN, channel: "call", level: "L4" },
  { afterMs: 20 * MIN, channel: "sms", level: "L4" },
];

/**
 * Tool approvals fit inside the 10-minute approval TTL: WhatsApp at +3, re-push at +5, call
 * at +6, SMS last at +8; at expiry an L1 "Expiró: denegada" notice (engine).
 */
export const APPROVAL_LADDER: readonly Rung[] = [
  { afterMs: 0, channel: "push", level: "L1" },
  { afterMs: 3 * MIN, channel: "whatsapp", level: "L3" },
  { afterMs: 5 * MIN, channel: "push", level: "L2" },
  { afterMs: 6 * MIN, channel: "call", level: "L4" },
  { afterMs: 8 * MIN, channel: "sms", level: "L4" },
];

export const ladderFor = (item: EscalationItem): readonly Rung[] =>
  item.source === "approval" ? APPROVAL_LADDER : STANDARD_LADDER;

export const LEVEL_RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
export const maxLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const minLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);
