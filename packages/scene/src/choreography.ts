import type { EmotionTag, RoomEventKind } from "@chalito/protocol";
import { seeded } from "./seed.js";

/**
 * Who stands where, as a pure function of (roomId, members, events, t): every viewer computes
 * the same scene from the same room events, and nothing is ever written back (brief §5 M11,
 * "zero position writes"). Positions are on the floor plane (x right, z towards the viewer).
 */

export type Presence = "online" | "away" | "busy" | "offline";

export interface SceneMember {
  companionId: string;
  /** Roster card id (D-060: image cards for the beta). */
  avatar: string;
  presence?: Presence;
}

/** A room event's metadata. There is deliberately no content field: the scene never shows content. */
export interface SceneEvent {
  eid: string;
  fromCompanionId: string;
  /** Addressed companions; empty = everyone. */
  to: readonly string[];
  kind: RoomEventKind;
  /** Epoch ms. */
  t: number;
}

export type Phase = "absent" | "entering" | "idle" | "walking" | "talking" | "listening" | "leaving";

export interface ActorState {
  companionId: string;
  avatar: string;
  phase: Phase;
  x: number;
  z: number;
  /** +1 facing right, -1 facing left (image cards flip, they don't turn). */
  facing: 1 | -1;
  emotion: EmotionTag;
  /** "talk" while speaking, "wave" stepping out of the portal. */
  gesture: "talk" | "wave" | null;
  /** When that gesture started (epoch ms), so every viewer plays it in step. */
  gestureAt: number | null;
  /** A speech-bubble icon over the speaker. Never content. */
  bubble: boolean;
  /** 0..1, the crouch before stepping through the portal (anticipation). */
  crouch: number;
  /** 0..1, how much of the companion is out of the portal (0 = inside it). */
  emerge: number;
}

export interface PortalState {
  /** 0 closed .. 1 fully open. */
  open: number;
  /** 0..1, the light burst as someone steps through. */
  burst: number;
}

export interface SceneState {
  actors: ActorState[];
  portal: PortalState;
}

/** Floor area companions wander in, and the portal at the back. */
export const FLOOR = { halfWidth: 1.7, near: 0.9, far: -0.9 } as const;
export const PORTAL = { x: 0, z: -1.35 } as const;

/** Timings (ms). */
export const ENTER_MS = 2600;
export const LEAVE_MS = 2400;
export const BUCKET_MS = 12_000;
export const TALK_MS = 5200;
const APPROACH_MS = 1400;
const RETURN_MS = 1400;
const SPEED = 0.55; // floor units per second
const MEET_GAP = 0.6;

/** Enter, in ms from the enter event: the portal opens, bursts, the companion crouches and steps out. */
const ENTER = { open: [0, 700], burst: [650, 1100], crouch: [800, 1250], step: [1150, 2000], close: [2000, 2600] };
/** Leave, in ms from the leave event: walk to the portal, crouch, step in, burst, close. */
const LEAVE = {
  open: [0, 700],
  walk: [0, 1100],
  crouch: [1100, 1400],
  step: [1350, 1750],
  burst: [1600, 1950],
  close: [1950, 2400],
};

/** Every viewer derives the same emotion from the kind (content is sealed and isn't ours to read). */
export const KIND_EMOTION: Partial<Record<RoomEventKind, EmotionTag>> = {
  notice: "happy",
  event_proposal: "excited",
  ask: "thinking",
  ack: "happy",
};
const PRESENCE_EMOTION: Record<Presence, EmotionTag> = {
  online: "neutral",
  away: "relaxed",
  busy: "thinking",
  offline: "tired",
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const span = (t: number, [a, b]: readonly number[]) => clamp01((t - a!) / (b! - a!));
const ease = (p: number) => p * p * (3 - 2 * p);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
/** Rises over [a, b], then falls back over [b, 2b - a]: a pulse. */
const pulse = (t: number, w: readonly number[]) => {
  const up = span(t, w);
  const down = span(t, [w[1]!, 2 * w[1]! - w[0]!]);
  return up * (1 - down);
};

interface P {
  x: number;
  z: number;
}

/** A wander spot for bucket k: the same for (room, companion, k) on every viewer. */
export const wanderSpot = (roomId: string, companionId: string, k: number): P => {
  const [a, b] = seeded(`${roomId}|${companionId}|${k}`);
  return { x: (a * 2 - 1) * FLOOR.halfWidth, z: lerp(FLOOR.far, FLOOR.near, b) };
};

/** Seeded wander: walk from the last bucket's spot to this one's, then stand. */
const wander = (roomId: string, m: SceneMember, t: number): { p: P; moving: boolean; dx: number } => {
  const still = m.presence && m.presence !== "online";
  const k = still ? 0 : Math.floor(t / BUCKET_MS);
  const to = wanderSpot(roomId, m.companionId, k);
  if (still) return { p: to, moving: false, dx: 0 };
  const from = wanderSpot(roomId, m.companionId, k - 1);
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const walkMs = Math.min((dist / SPEED) * 1000, BUCKET_MS * 0.6);
  const p = walkMs > 0 ? clamp01((t - k * BUCKET_MS) / walkMs) : 1;
  return {
    p: { x: lerp(from.x, to.x, ease(p)), z: lerp(from.z, to.z, ease(p)) },
    moving: p > 0 && p < 1,
    dx: to.x - from.x,
  };
};

/** Same input in any order → same scene: members by id, events deduplicated and by (t, eid). */
const normalise = (members: readonly SceneMember[], events: readonly SceneEvent[]) => {
  const byEid = new Map<string, SceneEvent>();
  for (const e of events) if (!byEid.has(e.eid)) byEid.set(e.eid, e);
  return {
    members: [...members].sort((a, b) => (a.companionId < b.companionId ? -1 : a.companionId > b.companionId ? 1 : 0)),
    events: [...byEid.values()].sort((a, b) => a.t - b.t || (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0)),
  };
};

type Norm = ReturnType<typeof normalise>;

/** The last enter/leave of `id` at or before t. */
const lastMove = (n: Norm, id: string, t: number): SceneEvent | null => {
  let last: SceneEvent | null = null;
  for (const e of n.events) {
    if (e.t > t) break;
    if (e.fromCompanionId === id && (e.kind === "enter" || e.kind === "leave")) last = e;
  }
  return last;
};

const presentAt = (n: Norm, id: string, t: number): "in" | "entering" | "leaving" | "out" => {
  const last = lastMove(n, id, t);
  if (!last) return n.members.some((m) => m.companionId === id) ? "in" : "out";
  if (last.kind === "enter") return t - last.t < ENTER_MS ? "entering" : "in";
  return t - last.t < LEAVE_MS ? "leaving" : "out";
};

/** The conversation `id` is in at t (as speaker or listener), the latest one started. */
const talkAt = (n: Norm, id: string, t: number): { e: SceneEvent; partner: string | null; speaker: boolean } | null => {
  let found: { e: SceneEvent; partner: string | null; speaker: boolean } | null = null;
  for (const e of n.events) {
    if (e.t > t) break;
    if (t - e.t >= TALK_MS || !KIND_EMOTION[e.kind]) continue;
    if (presentAt(n, e.fromCompanionId, e.t) !== "in") continue;
    const partner = e.to.find((c) => c !== e.fromCompanionId && presentAt(n, c, e.t) === "in") ?? null;
    if (e.fromCompanionId === id) found = { e, partner, speaker: true };
    else if (partner === id) found = { e, partner: e.fromCompanionId, speaker: false };
  }
  return found;
};

const memberOf = (n: Norm, id: string): SceneMember | undefined => n.members.find((m) => m.companionId === id);

/** Where `id` stands at t (and whether it's walking). Recursion only goes back in time. */
const placeAt = (n: Norm, roomId: string, id: string, t: number, depth = 0): { p: P; moving: boolean; dx: number } => {
  const m = memberOf(n, id) ?? { companionId: id, avatar: "chalito" };
  const base = wander(roomId, m, t);
  if (depth > 8) return base;
  const talk = talkAt(n, id, t);
  if (!talk) return base;
  const t0 = talk.e.t;
  const before = (c: string) => placeAt(n, roomId, c, t0 - 1, depth + 1).p;
  if (!talk.speaker) return { p: before(id), moving: false, dx: 0 };
  const from = before(id);
  if (!talk.partner) return { p: from, moving: false, dx: 0 };
  const other = before(talk.partner);
  const d = Math.hypot(from.x - other.x, from.z - other.z) || 1;
  const meet = { x: other.x + ((from.x - other.x) / d) * MEET_GAP, z: other.z + ((from.z - other.z) / d) * MEET_GAP };
  const dt = t - t0;
  if (dt < APPROACH_MS) {
    const p = ease(dt / APPROACH_MS);
    return { p: { x: lerp(from.x, meet.x, p), z: lerp(from.z, meet.z, p) }, moving: true, dx: meet.x - from.x };
  }
  if (dt > TALK_MS - RETURN_MS) {
    const p = ease((dt - (TALK_MS - RETURN_MS)) / RETURN_MS);
    return { p: { x: lerp(meet.x, base.p.x, p), z: lerp(meet.z, base.p.z, p) }, moving: true, dx: base.p.x - meet.x };
  }
  return { p: meet, moving: false, dx: other.x - meet.x };
};

/** The whole scene at time t. */
export const choreograph = (
  roomId: string,
  members: readonly SceneMember[],
  events: readonly SceneEvent[],
  t: number,
  /** Avatars of companions that already left (no longer in `members`), for their exit. */
  known: ReadonlyMap<string, string> = new Map(),
): SceneState => {
  const n = normalise(members, events);
  // Everyone the scene knows of: members now, plus anyone who left recently (to play their exit).
  const ids = new Set(n.members.map((m) => m.companionId));
  for (const e of n.events) if (e.kind === "leave" || e.kind === "enter") ids.add(e.fromCompanionId);
  const portal: PortalState = { open: 0, burst: 0 };
  const actors: ActorState[] = [];

  for (const id of [...ids].sort()) {
    const m = memberOf(n, id);
    const avatar = m?.avatar ?? known.get(id) ?? "chalito";
    const state = presentAt(n, id, t);
    const idle = PRESENCE_EMOTION[m?.presence ?? "online"];
    const a: ActorState = {
      companionId: id,
      avatar,
      phase: "absent",
      x: PORTAL.x,
      z: PORTAL.z,
      facing: 1,
      emotion: idle,
      gesture: null,
      gestureAt: null,
      bubble: false,
      crouch: 0,
      emerge: 0,
    };
    if (state === "out") {
      actors.push(a);
      continue;
    }
    if (state === "entering") {
      const e = lastMove(n, id, t)!;
      const dt = t - e.t;
      const land = wander(roomId, m ?? { companionId: id, avatar }, e.t + ENTER_MS).p;
      const step = ease(span(dt, ENTER.step));
      portal.open = Math.max(portal.open, span(dt, ENTER.open) * (1 - span(dt, ENTER.close)));
      portal.burst = Math.max(portal.burst, pulse(dt, ENTER.burst));
      Object.assign(a, {
        phase: "entering",
        x: lerp(PORTAL.x, land.x, step),
        z: lerp(PORTAL.z, land.z, step),
        facing: land.x >= PORTAL.x ? 1 : -1,
        emotion: "excited",
        crouch: pulse(dt, ENTER.crouch),
        emerge: clamp01(span(dt, ENTER.step) * 2.5),
        gesture: dt >= ENTER.step[1]! ? "wave" : null,
        gestureAt: dt >= ENTER.step[1]! ? e.t + ENTER.step[1]! : null,
      } satisfies Partial<ActorState>);
      actors.push(a);
      continue;
    }
    if (state === "leaving") {
      const e = lastMove(n, id, t)!;
      const dt = t - e.t;
      const start = placeAt(n, roomId, id, e.t - 1).p;
      const walk = ease(span(dt, LEAVE.walk));
      portal.open = Math.max(portal.open, span(dt, LEAVE.open) * (1 - span(dt, LEAVE.close)));
      portal.burst = Math.max(portal.burst, pulse(dt, LEAVE.burst));
      Object.assign(a, {
        phase: "leaving",
        x: lerp(start.x, PORTAL.x, walk),
        z: lerp(start.z, PORTAL.z, walk),
        facing: PORTAL.x >= start.x ? 1 : -1,
        emotion: "excited",
        crouch: pulse(dt, LEAVE.crouch),
        emerge: 1 - span(dt, LEAVE.step),
      } satisfies Partial<ActorState>);
      actors.push(a);
      continue;
    }
    const at = placeAt(n, roomId, id, t);
    const talk = talkAt(n, id, t);
    a.phase = talk
      ? talk.speaker
        ? at.moving
          ? "walking"
          : "talking"
        : "listening"
      : at.moving
        ? "walking"
        : "idle";
    a.x = at.p.x;
    a.z = at.p.z;
    a.emerge = 1;
    if (at.dx !== 0) a.facing = at.dx > 0 ? 1 : -1;
    else if (talk?.partner) {
      const other = placeAt(n, roomId, talk.partner, t).p;
      a.facing = other.x >= a.x ? 1 : -1;
    }
    if (talk) {
      a.emotion = KIND_EMOTION[talk.e.kind] ?? idle;
      if (talk.speaker) {
        a.bubble = true;
        a.gesture = "talk";
        a.gestureAt = talk.e.t;
      }
    }
    actors.push(a);
  }
  return { actors, portal };
};
