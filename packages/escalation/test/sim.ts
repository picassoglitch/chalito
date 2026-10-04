import { decide } from "../src/engine.js";
import type { Action, EscalationEvent, EscalationItem, History, Ladder, Presence, UserPrefs } from "../src/types.js";

export interface Logged {
  at: number;
  action: Action;
  /** The ladder's item when the action was decided (level/source for the quiet-hours property). */
  item?: EscalationItem;
}

/**
 * Plays the notifier: feeds events and due ticks to decide() in time order, applies its
 * actions (ladders, schedules, cancels, sends) and logs everything.
 */
export const simulate = (
  prefs: UserPrefs,
  steps: { at: number; event: EscalationEvent; presence?: Presence }[],
  opts: { until?: number; presence?: Presence } = {},
) => {
  const history: History = { ladders: [], sent: [] };
  const scheduled = new Map<string, number>();
  const log: Logged[] = [];
  const queue = [...steps].sort((a, b) => a.at - b.at);
  let presence = opts.presence ?? { desktopActive: false };
  const until = opts.until ?? (queue.at(-1)?.at ?? 0) + 48 * 3_600_000;

  for (let guard = 0; guard < 5000; guard++) {
    const nextTick = [...scheduled.entries()].sort((a, b) => a[1] - b[1])[0];
    const nextStep = queue[0];
    let at: number;
    let event: EscalationEvent;
    if (nextStep && (!nextTick || nextStep.at <= nextTick[1])) {
      queue.shift();
      at = nextStep.at;
      event = nextStep.event;
      if (nextStep.presence) presence = nextStep.presence;
    } else if (nextTick && nextTick[1] <= until) {
      scheduled.delete(nextTick[0]);
      at = nextTick[1];
      event = { type: "tick", nid: nextTick[0] };
    } else break;

    for (const action of decide(event, prefs, presence, history, at)) {
      const nid = "nid" in action ? action.nid : action.ladder.item.nid;
      const item =
        history.ladders.find((l) => l.item.nid === nid)?.item ??
        (action.type === "ladder" ? action.ladder.item : event.type === "notify" ? event.item : undefined);
      log.push({ at, action, ...(item ? { item } : {}) });
      apply(history, scheduled, action, at);
    }
  }
  return { log, history, sends: log.filter((l) => l.action.type === "send") };
};

const apply = (history: History, scheduled: Map<string, number>, a: Action, at: number) => {
  switch (a.type) {
    case "ladder": {
      const i = history.ladders.findIndex((l: Ladder) => l.item.coalesceKey === a.ladder.item.coalesceKey);
      if (i >= 0) history.ladders[i] = a.ladder;
      else history.ladders.push(a.ladder);
      break;
    }
    case "schedule":
      scheduled.set(a.nid, a.at);
      break;
    case "cancel":
      scheduled.delete(a.nid);
      break;
    case "send":
      if (a.channel === "whatsapp" || a.channel === "call" || a.channel === "sms")
        history.sent.push({ nid: a.nid, channel: a.channel, at });
      break;
    default:
      break;
  }
};

export const MIN = 60_000;
export const HOUR = 3_600_000;

/** 2026-10-05 12:00 in Mexico City (UTC-6, no DST). */
export const NOON_MX = Date.UTC(2026, 9, 5, 18, 0, 0);

export const item = (over: Partial<EscalationItem> = {}): EscalationItem => ({
  nid: "n1",
  source: "session_question",
  urgency: "high",
  level: "L4",
  counts: { approvals: 0, questions: 1, messages: 0, mesas: 0 },
  coalesceKey: "session:s1",
  deepLink: "/s/s1",
  createdAt: NOON_MX,
  ...over,
});

export const prefsAll = (over: Partial<UserPrefs> = {}): UserPrefs => ({
  tz: "America/Mexico_City",
  locale: "es",
  phone: { e164: "+14155550100", country: "US", verified: true, chargesNoticeAckAt: 1 },
  whatsapp: { optIn: true },
  calls: { enabled: true },
  ...over,
});

/** Remote sends as [minutes after t0, channel], desktop excluded. */
export const timeline = (sends: Logged[], t0: number) =>
  sends
    .filter((s) => s.action.type === "send" && s.action.channel !== "desktop")
    .map((s) => [Math.round((s.at - t0) / MIN), s.action.type === "send" ? s.action.channel : ""]);
