import type {
  Channel,
  Counts,
  Level,
  Locale,
  NotificationSource,
  OutboundTemplateVars,
  Urgency,
} from "@chalito/protocol";

/** The metadata a ladder needs. Never content: no titles, lines or session text. */
export interface EscalationItem {
  nid: string;
  source: NotificationSource;
  urgency: Urgency;
  /** The highest level this item may escalate to. */
  level: Level;
  counts: Counts;
  coalesceKey: string;
  deepLink: string;
  createdAt: number;
  /** Tool approvals: the 10-minute expiry. The ladder is clipped to it. */
  approvalExpiresAt?: number;
  /** Mesa starting: when it starts (snooze re-calls a minute before). */
  mesaStartsAt?: number;
}

export type EscalationEvent =
  /** A new item, or an update to one with the same coalesceKey. */
  | { type: "notify"; item: EscalationItem }
  /** A scheduled ladder step fired (Cloud Tasks). */
  | { type: "tick"; nid: string }
  /** Acknowledged anywhere: one ladder by nid or coalesceKey, or everything pending. */
  | { type: "ack"; via: Channel | "app"; nid?: string; coalesceKey?: string; all?: boolean }
  /** DTMF 2 on a call. */
  | { type: "snooze"; nid: string }
  /** The approval behind a ladder expired (or was denied by expiry). */
  | { type: "approval_expired"; nid: string };

export interface UserPrefs {
  tz: string;
  locale: Locale;
  /** null: no quiet hours. Omitted: the default 23:00–07:00. */
  quietHours?: { start: string; end: string } | null;
  phone?: { e164: string; country: string; verified: boolean; chargesNoticeAckAt: number | null } | null;
  whatsapp?: { optIn: boolean };
  calls?: { enabled: boolean };
  /** Off by default for MX numbers (D-013 cost: ~21x WhatsApp); on elsewhere unless set. */
  sms?: { enabled: boolean };
  /** Sources whose L4 step may break quiet hours (e.g. "security"). */
  l4QuietOverride?: NotificationSource[];
}

export interface Presence {
  /** The desktop companion is active (focused/recently used) right now. */
  desktopActive: boolean;
}

export type LadderState = "pending" | "acked" | "snoozed" | "expired" | "done";

export interface Ladder {
  item: EscalationItem;
  state: LadderState;
  /** Index of the next rung to run. */
  step: number;
  /** When the ladder opened (presence hold is measured from here; never moves). */
  openedAt: number;
  /** The rung clock: rung i is due at startedAt + afterMs. Holds shift it so rungs keep their spacing. */
  startedAt: number;
  nextAt: number | null;
  ackedAt: number | null;
  ackedVia: Channel | "app" | null;
}

export interface SentRecord {
  nid: string;
  channel: Channel;
  at: number;
}

export interface History {
  /** Active and recent ladders, at most one per coalesceKey. */
  ladders: Ladder[];
  /** Outbound sends (at least today's), for the daily caps. */
  sent: SentRecord[];
}

/** Metadata-only payload for push and the desktop companion. */
export interface PushPayload {
  nid: string;
  level: Level;
  source: NotificationSource;
  urgency: Urgency;
  counts: Counts;
  total: number;
  deepLink: string;
  /** A fixed notice the app renders in the user's language (e.g. "Expiró: denegada"). */
  notice?: "approval_expired";
}

export type SuppressReason =
  "quiet_hours" | "cap" | "disabled" | "no_verified_phone" | "no_charges_ack" | "presence_hold";

export type Action =
  | { type: "send"; channel: "desktop" | "push"; nid: string; level: Level; payload: PushPayload }
  | {
      type: "send";
      channel: "whatsapp" | "sms";
      nid: string;
      level: Level;
      payload: OutboundTemplateVars;
    }
  /** The notifier builds the spoken briefing (briefing.ts) when it places the call. */
  | { type: "send"; channel: "call"; nid: string; level: Level; payload: { nid: string } }
  | { type: "schedule"; nid: string; at: number }
  | { type: "cancel"; nid: string }
  | { type: "suppressed"; nid: string; channel: Channel; reason: SuppressReason }
  /** Persist this ladder (replaces the one with the same coalesceKey). */
  | { type: "ladder"; ladder: Ladder };
