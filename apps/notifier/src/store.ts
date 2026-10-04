import type { History, Ladder, Presence, SentRecord, UserPrefs } from "@chalito/escalation";
import type { Channel, Counts, Level, NotificationSource, RelayedCommand, Urgency } from "@chalito/protocol";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** One waiting item for the spoken briefing (labels are metadata; `line` only with call briefing on). */
export interface CallItem {
  /** chalito.call_lines.lid: the call's signed ref lists the items it was placed for. */
  lid: string;
  deviceLabel: string;
  sessionLabel: string;
  line?: string;
  /** Where a spoken answer goes (answer_item); never read out. */
  deviceId?: string;
  sid?: string;
}

/** A pending approval the companion may re-push to the app (push_approval); it can't approve it. */
export interface PendingApproval {
  aid: string;
  deviceLabel: string;
  sessionLabel: string;
}

/** What the notifier reads and writes. Postgres in production (postgres-store.ts), memory in tests. */
export interface NotifierStore {
  /**
   * Runs `fn` holding the user's escalation lock (one decision at a time per user: Pub/Sub
   * and Cloud Tasks may deliver concurrently). Writes inside `fn` commit together.
   */
  withUser<T>(uid: string, fn: (tx: UserTx) => Promise<T>): Promise<T>;
  /** Inbound webhooks: whose verified phone is this? */
  findUserByPhone(e164: string): Promise<string | null>;
  pushSubscriptions(uid: string): Promise<PushSubscriptionRecord[]>;
  deletePushSubscription(uid: string, endpoint: string): Promise<void>;
  /** A channel opt-out from a webhook (WhatsApp quick reply, SMS STOP). */
  optOut(uid: string, channel: "whatsapp" | "sms"): Promise<void>;
  /** Waiting items for the call briefing; lines only when the user enabled call briefing. */
  callItems(uid: string): Promise<{ callBriefingEnabled: boolean; items: CallItem[]; mesaTitle?: string }>;
  pendingApprovals(uid: string): Promise<PendingApproval[]>;
  /** The user's companion name for the voice persona (null: "Chalito"). */
  companionName(uid: string): Promise<string | null>;
  /** The plan the hub reported (users.tier) and the user's time zone, for monthly caps. */
  planInfo(uid: string): Promise<{ hubTier: string | null; tz: string; locale: "es" | "en" } | null>;
  /** WhatsApp/SMS/call sends since `sinceMs`, not counting suppressed (failed) ones. */
  monthlySends(uid: string, sinceMs: number): Promise<Record<"whatsapp" | "sms" | "call", number>>;
  /** Voice seconds metered since `sinceMs` (desktop and calls), from the usage outbox. */
  voiceSecondsSince(uid: string, sinceMs: number): Promise<number>;
  /** A queued send didn't go out (cap, no tokens, hub down): it no longer counts. */
  markSuppressed(uid: string, nid: string, channel: "whatsapp" | "sms" | "call", reason: string): Promise<void>;
  /** Inserts an in-app notification unless one with that nid exists (once-a-month notes). */
  noteOnce(uid: string, row: NotificationRow): Promise<void>;
  /** Marks a voice call ref used (global single use); false if it was used before. */
  claimCallRef(refHash: string, expiresAt: number): Promise<boolean>;
  /** Device public box key, to seal a relayed prompt for that agent. */
  agentPubBox(uid: string, deviceId: string): Promise<string | null>;
  insertRelayedCommand(
    uid: string,
    targetDeviceId: string,
    cid: string,
    env: RelayedCommand,
    expiresAt: number,
  ): Promise<void>;
}

/** The users/{uid}/notifications row the desktop and apps watch (Realtime broadcast on write). */
export interface NotificationRow {
  nid: string;
  source: NotificationSource;
  urgency: Urgency;
  counts: Counts;
  deepLink: string;
  coalesceKey: string;
  state: "pending" | "acked" | "snoozed" | "expired";
  step: number;
  nextAt: number | null;
  createdAt: number;
  /** Set when this decision raised the level shown on the desktop. */
  level?: Level;
  /** Channels used by this decision (merged with the ones already recorded). */
  channels: Channel[];
  ackedAt: number | null;
  ackedVia: Channel | "app" | null;
}

export interface UserTx {
  prefs(): Promise<UserPrefs | null>;
  presence(): Promise<Presence>;
  upsertNotification(row: NotificationRow): Promise<void>;
  /** Active ladders plus recent ones, and sends since `sinceMs` (enough for today's caps). */
  history(sinceMs: number): Promise<History>;
  saveLadder(ladder: Ladder): Promise<void>;
  recordSent(rec: SentRecord, coalesceKey: string): Promise<void>;
}

/** In-memory store for tests and local runs. */
export class MemoryStore implements NotifierStore {
  prefs = new Map<string, UserPrefs>();
  ladders = new Map<string, Ladder[]>();
  sent = new Map<string, SentRecord[]>();
  subs = new Map<string, PushSubscriptionRecord[]>();
  optOuts: { uid: string; channel: string }[] = [];
  calls = new Map<string, { callBriefingEnabled: boolean; items: CallItem[]; mesaTitle?: string }>();
  boxKeys = new Map<string, string>();
  presence = new Map<string, Presence>();
  notifications = new Map<string, NotificationRow>();
  commands: { uid: string; targetDeviceId: string; cid: string; env: RelayedCommand; expiresAt: number }[] = [];
  approvals = new Map<string, PendingApproval[]>();
  companions = new Map<string, string>();
  callRefs = new Set<string>();
  tiers = new Map<string, string>();
  voiceSeconds = new Map<string, number>();
  suppressedSends: (SentRecord & { reason: string })[] = [];
  #locks = new Map<string, Promise<unknown>>();

  async withUser<T>(uid: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    const prev = this.#locks.get(uid) ?? Promise.resolve();
    const run = prev.then(() =>
      fn({
        prefs: async () => this.prefs.get(uid) ?? null,
        presence: async () => this.presence.get(uid) ?? { desktopActive: false },
        upsertNotification: async (row) => {
          const key = `${uid}/${row.nid}`;
          const prev = this.notifications.get(key);
          this.notifications.set(key, {
            ...row,
            level: row.level ?? prev?.level ?? "L0",
            channels: [...new Set([...(prev?.channels ?? []), ...row.channels])],
          });
        },
        history: async (since) => ({
          ladders: [...(this.ladders.get(uid) ?? [])],
          sent: (this.sent.get(uid) ?? []).filter((s) => s.at >= since),
        }),
        saveLadder: async (l) => {
          const list = this.ladders.get(uid) ?? [];
          const i = list.findIndex((x) => x.item.coalesceKey === l.item.coalesceKey);
          if (i >= 0) list[i] = l;
          else list.push(l);
          this.ladders.set(uid, list);
        },
        recordSent: async (rec) => void this.sent.set(uid, [...(this.sent.get(uid) ?? []), rec]),
      }),
    );
    this.#locks.set(
      uid,
      run.catch(() => undefined),
    );
    return run;
  }
  async findUserByPhone(e164: string) {
    for (const [uid, p] of this.prefs) if (p.phone?.e164 === e164 && p.phone.verified) return uid;
    return null;
  }
  async pushSubscriptions(uid: string) {
    return this.subs.get(uid) ?? [];
  }
  async deletePushSubscription(uid: string, endpoint: string) {
    this.subs.set(
      uid,
      (this.subs.get(uid) ?? []).filter((s) => s.endpoint !== endpoint),
    );
  }
  async optOut(uid: string, channel: "whatsapp" | "sms") {
    this.optOuts.push({ uid, channel });
    const p = this.prefs.get(uid);
    if (p)
      this.prefs.set(
        uid,
        channel === "whatsapp" ? { ...p, whatsapp: { optIn: false } } : { ...p, sms: { enabled: false } },
      );
  }
  async callItems(uid: string) {
    return this.calls.get(uid) ?? { callBriefingEnabled: false, items: [] };
  }
  async pendingApprovals(uid: string) {
    return this.approvals.get(uid) ?? [];
  }
  async planInfo(uid: string) {
    const p = this.prefs.get(uid);
    return p ? { hubTier: this.tiers.get(uid) ?? null, tz: p.tz, locale: p.locale } : null;
  }
  async monthlySends(uid: string, sinceMs: number) {
    const out = { whatsapp: 0, sms: 0, call: 0 };
    for (const s of this.sent.get(uid) ?? [])
      if (s.at >= sinceMs && s.channel in out) out[s.channel as keyof typeof out]++;
    return out;
  }
  async voiceSecondsSince(uid: string) {
    return this.voiceSeconds.get(uid) ?? 0;
  }
  async markSuppressed(uid: string, nid: string, channel: "whatsapp" | "sms" | "call", reason: string) {
    const list = this.sent.get(uid) ?? [];
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i]!.nid === nid && list[i]!.channel === channel) {
        this.suppressedSends.push({ ...list[i]!, reason });
        list.splice(i, 1);
        return;
      }
  }
  async noteOnce(uid: string, row: NotificationRow) {
    const key = `${uid}/${row.nid}`;
    if (!this.notifications.has(key)) this.notifications.set(key, row);
  }
  async claimCallRef(refHash: string) {
    if (this.callRefs.has(refHash)) return false;
    this.callRefs.add(refHash);
    return true;
  }
  async companionName(uid: string) {
    return this.companions.get(uid) ?? null;
  }
  async agentPubBox(uid: string, deviceId: string) {
    return this.boxKeys.get(`${uid}/${deviceId}`) ?? null;
  }
  async insertRelayedCommand(uid: string, targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number) {
    this.commands.push({ uid, targetDeviceId, cid, env, expiresAt });
  }
}
