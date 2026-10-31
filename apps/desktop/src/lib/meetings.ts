import type { Level } from "@chalito/protocol";
import { IpcUnavailableError } from "./ipc.js";
import { RANK, type PetContext } from "./pet-context.js";
import type { FollowUpsView, MeetingsIpc, MeetingsUpcoming, UpcomingMeeting } from "./meetings-ipc.js";

export type Stage = "ten" | "two";

/** A meeting warning: 10 minutes before is a glance (L1), 2 minutes before a wave (L2). Never more. */
export interface MeetingWarning {
  key: string;
  meeting: UpcomingMeeting;
  stage: Stage;
  level: "L1" | "L2";
  /** Whole minutes left, rounded up. */
  minutes: number;
}

const TEN_MS = 10 * 60_000;
const TWO_MS = 2 * 60_000;

/** The warnings due at `nowMs`. At start time there's none: Chalito never takes over the screen (owner, 2026-10-25). */
export const meetingWarnings = (
  meetings: readonly UpcomingMeeting[],
  nowMs: number,
  o: { acked: ReadonlySet<string>; inCall: boolean },
): MeetingWarning[] => {
  if (o.inCall) return [];
  const out: MeetingWarning[] = [];
  for (const m of meetings) {
    const left = m.startMs - nowMs;
    if (left <= 0) continue;
    const stage: Stage | null = left <= TWO_MS ? "two" : left <= TEN_MS ? "ten" : null;
    if (!stage) continue;
    const key = `${m.id}#${stage}`;
    if (o.acked.has(key)) continue;
    out.push({ key, meeting: m, stage, level: stage === "two" ? "L2" : "L1", minutes: Math.ceil(left / 60_000) });
  }
  return out.sort((a, b) => a.meeting.startMs - b.meeting.startMs);
};

/** The pet's level with the meeting warnings folded in: the higher one wins, so an approval still outranks a meeting. */
export const withMeetingLevel = (ctx: PetContext, level: Level | null): PetContext =>
  level && (!ctx.level || RANK[level] > RANK[ctx.level]) ? { ...ctx, level } : ctx;

/** "10:30" in the person's zone and locale. */
export const formatStart = (ms: number, o: { tz?: string; locale?: string } = {}): string =>
  new Intl.DateTimeFormat(o.locale, { hour: "numeric", minute: "2-digit", ...(o.tz ? { timeZone: o.tz } : {}) }).format(
    new Date(ms),
  );

export type PollError = "unavailable" | "internal";

export interface MeetingsSnapshot {
  /** null until the agent has answered once. */
  configured: boolean | null;
  error: MeetingsUpcoming["error"];
  unsupported: number;
  /** The last poll of the agent failed (the rest is from the poll before). */
  pollError: PollError | null;
  warnings: MeetingWarning[];
  followUps: FollowUpsView | null;
}

const POLL_MS = 60_000;
const TICK_MS = 5_000;

/** Polls the agent for the calendar and follow-ups, and recomputes warnings every few seconds. */
export class MeetingWatch {
  #up: MeetingsUpcoming | null = null;
  #acked = new Set<string>();
  #snap: MeetingsSnapshot = {
    configured: null,
    error: null,
    unsupported: 0,
    pollError: null,
    warnings: [],
    followUps: null,
  };
  #subs = new Set<() => void>();
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    readonly ipc: MeetingsIpc,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (fn: () => void) => {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  };
  getSnapshot = () => this.#snap;

  level(): Level | null {
    return this.#snap.warnings.some((w) => w.level === "L2") ? "L2" : this.#snap.warnings.length ? "L1" : null;
  }

  start(): () => void {
    void this.poll();
    this.#timers.push(
      setInterval(() => void this.poll(), POLL_MS),
      setInterval(() => this.recompute(), TICK_MS),
    );
    return () => {
      this.#timers.forEach(clearInterval);
      this.#timers = [];
    };
  }

  /** A failed call keeps what the last good one said: a hiccup must not hide a 2-minute warning or undo dismissals. */
  async poll(): Promise<void> {
    const kind = (e: unknown): PollError => (e instanceof IpcUnavailableError ? "unavailable" : "internal");
    const [up, fu] = await Promise.all([
      this.ipc.upcoming().then(
        (v) => ({ v }),
        (e: unknown) => ({ e: kind(e) }),
      ),
      this.ipc.followUps().catch(() => null),
    ]);
    if ("v" in up) {
      this.#up = up.v;
      this.#set({ configured: up.v.configured, error: up.v.error, unsupported: up.v.unsupported, pollError: null });
    } else {
      // Unknown call state now: fail toward warning.
      if (this.#up) this.#up = { ...this.#up, inCall: false };
      this.#set({ pollError: up.e });
    }
    if (fu) this.#set({ followUps: fu });
    this.recompute();
  }

  recompute(): void {
    const now = this.now();
    const meetings = this.#up?.meetings ?? [];
    // Acks only matter until their meeting starts.
    for (const k of this.#acked)
      if (!meetings.some((m) => k.startsWith(`${m.id}#`) && m.startMs > now)) this.#acked.delete(k);
    const warnings = meetingWarnings(meetings, now, { acked: this.#acked, inCall: this.#up?.inCall ?? false });
    const same =
      warnings.length === this.#snap.warnings.length &&
      warnings.every((w, i) => w.key === this.#snap.warnings[i]?.key && w.minutes === this.#snap.warnings[i]?.minutes);
    if (!same) this.#set({ warnings });
  }

  ack(key: string): void {
    this.#acked.add(key);
    this.recompute();
  }

  async decide(ref: string, choice: "yes" | "later" | "no") {
    const r = await this.ipc.decide(ref, choice);
    await this.poll();
    return r;
  }

  #set(patch: Partial<MeetingsSnapshot>) {
    this.#snap = { ...this.#snap, ...patch };
    for (const fn of this.#subs) fn();
  }
}
