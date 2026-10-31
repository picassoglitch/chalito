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

/** Tool approvals fit the 10-min TTL: WhatsApp +3, re-push +5, call +6, SMS +8; then an L1
 * "Expiró: denegada" notice at expiry (engine). */
export const APPROVAL_LADDER: readonly Rung[] = [
  { afterMs: 0, channel: "push", level: "L1" },
  { afterMs: 3 * MIN, channel: "whatsapp", level: "L3" },
  { afterMs: 5 * MIN, channel: "push", level: "L2" },
  { afterMs: 6 * MIN, channel: "call", level: "L4" },
  { afterMs: 8 * MIN, channel: "sms", level: "L4" },
];

/** A coding session finished a turn: one push, never WhatsApp, a call or SMS. */
export const TURN_LADDER: readonly Rung[] = [{ afterMs: 0, channel: "push", level: "L1" }];

/** A session looks stuck or stalled: a push, a second one 5 min later, never WhatsApp, a call or SMS. */
export const ALERT_LADDER: readonly Rung[] = [
  { afterMs: 0, channel: "push", level: "L1" },
  { afterMs: 5 * MIN, channel: "push", level: "L2" },
];

export const ladderFor = (item: EscalationItem): readonly Rung[] =>
  item.source === "approval"
    ? APPROVAL_LADDER
    : item.source === "turn_finished"
      ? TURN_LADDER
      : item.source === "agent_alert"
        ? ALERT_LADDER
        : STANDARD_LADDER;

/** The coding session an item belongs to: its own `sid`, or the one its "/s/<sid>" link names. */
export const sidOf = (item: EscalationItem): string | undefined =>
  item.sid ?? /^\/s\/([^/?#]+)$/.exec(item.deepLink)?.[1];

export const LEVEL_RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
export const maxLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
export const minLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);
