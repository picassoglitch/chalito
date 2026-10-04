import type { Sql, TransactionSql } from "postgres";
import type { HubUsageEvent } from "@chalito/protocol";
import { enqueueUsage } from "./postgres-outbox.js";

/**
 * Desktop voice sessions, metered on the server (R-H6, migration 20261004003010). Billing follows
 * the api's clock from the moment it minted the session, capped at the session's `maxSeconds`;
 * what the client reports is never billed. One open session per owner.
 */
export interface VoiceSession {
  sourceId: string;
  owner: string;
  /** desktop push-to-talk (apps/api) or a phone call's voice (apps/notifier). */
  channel: "desktop" | "call";
  /** The desktop device, or the CallSid. */
  deviceId: string;
  reservationId: string;
  model: string;
  startedAt: number;
  maxSeconds: number;
  billedSeconds: number;
  endedAt: number | null;
  /** The provider's call id once the api connected the call (desktop WebRTC via the api's SDP proxy). */
  callId?: string | null;
}

/** Builds the usage event for `seconds` more of a session; its source_id is `<session>:<total>`. */
export type VoiceEventFor = (s: VoiceSession, seconds: number, total: number) => HubUsageEvent | null;

export interface AdvanceResult {
  found: boolean;
  /** Seconds billed by this call (0 when nothing new). */
  billed: number;
  total: number;
  maxSeconds: number;
  ended: boolean;
  /** The session's hub reservation (to settle on end). */
  reservationId?: string;
  /** The provider call id, when the api connected the call (to hang it up). */
  callId?: string | null;
}

export interface VoiceSessionStore {
  /** "busy" when the owner already has an open session on this channel. */
  open(s: Omit<VoiceSession, "billedSeconds" | "endedAt">): Promise<"opened" | "busy">;
  /**
   * Bills up to min(elapsed, maxSeconds) (all of maxSeconds with `full`) and, with `end`, closes
   * the session — in one transaction with the usage event.
   */
  advance(p: {
    owner: string;
    sourceId: string;
    now: number;
    end: boolean;
    full?: boolean;
    event: VoiceEventFor;
  }): Promise<AdvanceResult>;
  /** Open sessions past started + max + grace (never ended): the sweep bills them in full. */
  stale(now: number, graceMs: number, owner?: string, channel?: VoiceSession["channel"]): Promise<VoiceSession[]>;
  /** Records the call id of an open session (the api hangs that call up at the cap or on revoke). */
  setCallId(owner: string, sourceId: string, callId: string): Promise<boolean>;
  /** The owner's open sessions on one device (e.g. to hang them up when the device is revoked). */
  openFor(owner: string, deviceId: string): Promise<VoiceSession[]>;
  /** Open sessions on a channel (all owners, or one): phone calls to check against the cap or end on revoke. */
  openOn(channel: VoiceSession["channel"], owner?: string): Promise<VoiceSession[]>;
}

/** Billed seconds for a session at `now`. */
export const dueSeconds = (s: Pick<VoiceSession, "startedAt" | "maxSeconds">, now: number, full = false) =>
  full ? s.maxSeconds : Math.max(0, Math.min(s.maxSeconds, Math.floor((now - s.startedAt) / 1000)));

/**
 * Closes stale sessions and bills them in full, then settles their reservations. Run by the
 * notifier's drain task every minute, and by the api for an owner before opening a new session.
 */
export const sweepVoiceSessions = async (p: {
  store: VoiceSessionStore;
  now: number;
  graceMs?: number;
  owner?: string;
  /** Only this channel's sessions (the api prices desktop voice only; calls are the notifier's). */
  channel?: VoiceSession["channel"];
  event: VoiceEventFor;
  settle: (reservationId: string) => Promise<unknown>;
  /**
   * Ends a stale session's live call, if any (best effort; billing doesn't wait on it): the
   * OpenAI call id, and for a phone call the Twilio call (`deviceId` is its CallSid).
   */
  hangup?: (s: VoiceSession) => Promise<unknown>;
}) => {
  const stale = await p.store.stale(p.now, p.graceMs ?? 120_000, p.owner, p.channel);
  for (const s of stale) {
    if (p.hangup) await p.hangup(s).catch(() => undefined);
    const r = await p.store.advance({
      owner: s.owner,
      sourceId: s.sourceId,
      now: p.now,
      end: true,
      full: true,
      event: p.event,
    });
    if (r.ended) await p.settle(s.reservationId).catch(() => undefined);
  }
  return stale.length;
};

type Row = {
  source_id: string;
  owner: string;
  channel: "desktop" | "call";
  device_id: string;
  reservation_id: string;
  model: string;
  started_at: Date;
  max_seconds: number;
  billed_seconds: number;
  ended_at: Date | null;
  call_id?: string | null;
};
const fromRow = (r: Row): VoiceSession => ({
  sourceId: r.source_id,
  owner: r.owner,
  channel: r.channel,
  deviceId: r.device_id,
  reservationId: r.reservation_id,
  model: r.model,
  startedAt: r.started_at.getTime(),
  maxSeconds: r.max_seconds,
  billedSeconds: r.billed_seconds,
  endedAt: r.ended_at ? r.ended_at.getTime() : null,
  callId: r.call_id ?? null,
});

export class PostgresVoiceSessions implements VoiceSessionStore {
  constructor(private readonly sql: Sql) {}

  async open(s: Omit<VoiceSession, "billedSeconds" | "endedAt">) {
    const rows = await this.sql`
      insert into chalito_private.voice_sessions
        (source_id, owner, channel, device_id, reservation_id, model, started_at, max_seconds)
      values (${s.sourceId}, ${s.owner}, ${s.channel}, ${s.deviceId}, ${s.reservationId}, ${s.model}, ${new Date(s.startedAt)}, ${s.maxSeconds})
      on conflict do nothing
      returning source_id`;
    return rows.length ? ("opened" as const) : ("busy" as const);
  }

  async advance(p: {
    owner: string;
    sourceId: string;
    now: number;
    end: boolean;
    full?: boolean;
    event: VoiceEventFor;
  }) {
    return (await this.sql.begin(async (tx: TransactionSql) => {
      const [r] = await tx<Row[]>`
        select * from chalito_private.voice_sessions
        where source_id = ${p.sourceId} and owner = ${p.owner} for update`;
      if (!r) return { found: false, billed: 0, total: 0, maxSeconds: 0, ended: false };
      const s = fromRow(r);
      if (s.endedAt !== null)
        return {
          found: true,
          billed: 0,
          total: s.billedSeconds,
          maxSeconds: s.maxSeconds,
          ended: true,
          reservationId: s.reservationId,
          callId: s.callId ?? null,
        };
      const total = Math.max(s.billedSeconds, dueSeconds(s, p.now, p.full));
      const billed = total - s.billedSeconds;
      if (billed > 0) await enqueueUsage(tx, s.owner, [p.event(s, billed, total)]);
      await tx`
        update chalito_private.voice_sessions
        set billed_seconds = ${total}, last_beat_at = ${new Date(p.now)},
            ended_at = ${p.end ? new Date(p.now) : null}, closed_by = ${p.end ? (p.full ? "sweep" : "end") : null}
        where source_id = ${p.sourceId}`;
      return {
        found: true,
        billed,
        total,
        maxSeconds: s.maxSeconds,
        ended: p.end,
        reservationId: s.reservationId,
        callId: s.callId ?? null,
      };
    })) as AdvanceResult;
  }

  async stale(now: number, graceMs: number, owner?: string, channel?: VoiceSession["channel"]) {
    const rows = await this.sql<Row[]>`
      select * from chalito_private.voice_sessions
      where ended_at is null
        and started_at + make_interval(secs => max_seconds) + make_interval(secs => ${graceMs / 1000}) < ${new Date(now)}
        ${owner ? this.sql`and owner = ${owner}` : this.sql``}
        ${channel ? this.sql`and channel = ${channel}` : this.sql``}
      order by started_at limit 500`;
    return rows.map(fromRow);
  }

  async setCallId(owner: string, sourceId: string, callId: string) {
    const rows = await this.sql`
      update chalito_private.voice_sessions set call_id = ${callId}
      where source_id = ${sourceId} and owner = ${owner} and ended_at is null
      returning source_id`;
    return rows.length > 0;
  }

  async openFor(owner: string, deviceId: string) {
    const rows = await this.sql<Row[]>`
      select * from chalito_private.voice_sessions
      where owner = ${owner} and device_id = ${deviceId} and ended_at is null`;
    return rows.map(fromRow);
  }

  async openOn(channel: VoiceSession["channel"], owner?: string) {
    // Few rows: the one-open-per-(owner, channel) partial index holds only open sessions.
    const rows = await this.sql<Row[]>`
      select * from chalito_private.voice_sessions
      where channel = ${channel} and ended_at is null
        ${owner ? this.sql`and owner = ${owner}` : this.sql``}`;
    return rows.map(fromRow);
  }
}

export class MemoryVoiceSessions implements VoiceSessionStore {
  readonly sessions = new Map<string, VoiceSession>();
  readonly events: HubUsageEvent[] = [];

  async open(s: Omit<VoiceSession, "billedSeconds" | "endedAt">) {
    if ([...this.sessions.values()].some((x) => x.owner === s.owner && x.channel === s.channel && x.endedAt === null))
      return "busy" as const;
    this.sessions.set(s.sourceId, { ...s, billedSeconds: 0, endedAt: null });
    return "opened" as const;
  }

  async advance(p: {
    owner: string;
    sourceId: string;
    now: number;
    end: boolean;
    full?: boolean;
    event: VoiceEventFor;
  }) {
    const s = this.sessions.get(p.sourceId);
    if (!s || s.owner !== p.owner) return { found: false, billed: 0, total: 0, maxSeconds: 0, ended: false };
    if (s.endedAt !== null)
      return {
        found: true,
        billed: 0,
        total: s.billedSeconds,
        maxSeconds: s.maxSeconds,
        ended: true,
        reservationId: s.reservationId,
        callId: s.callId ?? null,
      };
    const total = Math.max(s.billedSeconds, dueSeconds(s, p.now, p.full));
    const billed = total - s.billedSeconds;
    if (billed > 0) {
      const e = p.event(s, billed, total);
      if (e && !this.events.some((x) => x.source_id === e.source_id)) this.events.push(e);
    }
    s.billedSeconds = total;
    if (p.end) s.endedAt = p.now;
    return {
      found: true,
      billed,
      total,
      maxSeconds: s.maxSeconds,
      ended: p.end,
      reservationId: s.reservationId,
      callId: s.callId ?? null,
    };
  }

  async stale(now: number, graceMs: number, owner?: string, channel?: VoiceSession["channel"]) {
    return [...this.sessions.values()].filter(
      (s) =>
        s.endedAt === null &&
        s.startedAt + s.maxSeconds * 1000 + graceMs < now &&
        (!owner || s.owner === owner) &&
        (!channel || s.channel === channel),
    );
  }

  async setCallId(owner: string, sourceId: string, callId: string) {
    const v = this.sessions.get(sourceId);
    if (!v || v.owner !== owner || v.endedAt !== null) return false;
    v.callId = callId;
    return true;
  }

  async openFor(owner: string, deviceId: string) {
    return [...this.sessions.values()].filter(
      (v) => v.owner === owner && v.deviceId === deviceId && v.endedAt === null,
    );
  }

  async openOn(channel: VoiceSession["channel"], owner?: string) {
    return [...this.sessions.values()].filter(
      (v) => v.channel === channel && v.endedAt === null && (!owner || v.owner === owner),
    );
  }
}
