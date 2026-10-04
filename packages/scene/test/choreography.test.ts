import { describe, expect, it } from "vitest";
import {
  BUCKET_MS,
  ENTER_MS,
  FLOOR,
  LEAVE_MS,
  PORTAL,
  TALK_MS,
  choreograph,
  wanderSpot,
  type SceneEvent,
  type SceneMember,
} from "../src/index.js";

const ROOM = "room_fam1";
const A = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "chl_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "chl_cccccccccccccccccccccccccc";
const T0 = 1_760_000_000_000;
const members: SceneMember[] = [
  { companionId: A, avatar: "chalito" },
  { companionId: B, avatar: "luna" },
  { companionId: C, avatar: "tito" },
];
const ev = (eid: string, from: string, kind: SceneEvent["kind"], t: number, to: string[] = []): SceneEvent => ({
  eid,
  fromCompanionId: from,
  to,
  kind,
  t,
});
const events: SceneEvent[] = [
  ev("e1", C, "enter", T0),
  ev("e2", A, "notice", T0 + 6000, [B]),
  ev("e3", B, "ask", T0 + 14_000),
  ev("e4", C, "leave", T0 + 20_000),
];
const actor = (s: ReturnType<typeof choreograph>, id: string) => s.actors.find((a) => a.companionId === id)!;

describe("deterministic choreography (zero position writes)", () => {
  it("two viewers with the same events in any order (and duplicates) see the same scene", () => {
    const viewer2Members = [...members].reverse();
    const viewer2Events = [events[3]!, events[1]!, events[0]!, events[2]!, events[1]!];
    for (let t = T0 - 5000; t < T0 + 40_000; t += 250) {
      expect(choreograph(ROOM, viewer2Members, viewer2Events, t)).toEqual(choreograph(ROOM, members, events, t));
    }
  });

  it("the seeded wander depends on room, companion and time bucket, and stays on the floor", () => {
    expect(wanderSpot(ROOM, A, 7)).toEqual(wanderSpot(ROOM, A, 7));
    expect(wanderSpot(ROOM, A, 7)).not.toEqual(wanderSpot(ROOM, A, 8));
    expect(wanderSpot(ROOM, A, 7)).not.toEqual(wanderSpot(ROOM, B, 7));
    expect(wanderSpot(ROOM, A, 7)).not.toEqual(wanderSpot("room_other", A, 7));
    for (let k = 0; k < 200; k++) {
      const p = wanderSpot(ROOM, A, k);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(FLOOR.halfWidth);
      expect(p.z).toBeGreaterThanOrEqual(FLOOR.far);
      expect(p.z).toBeLessThanOrEqual(FLOOR.near);
    }
    // Settled at its spot once the bucket's walk is over.
    const k = Math.floor(T0 / BUCKET_MS) + 1;
    const s = choreograph(ROOM, members, [], k * BUCKET_MS + BUCKET_MS - 1);
    expect(actor(s, A)).toMatchObject({ phase: "idle", ...wanderSpot(ROOM, A, k) });
  });
});

describe("portal teleport", () => {
  it("on enter: the portal opens, bursts, the companion crouches and steps out excited, then it closes", () => {
    const at = (dt: number) => choreograph(ROOM, members, events, T0 + dt);
    const before = choreograph(ROOM, members.slice(0, 2), [events[0]!], T0 - 1);
    expect(before.portal.open).toBe(0);
    expect(actor(before, C).phase).toBe("absent");

    let maxOpen = 0;
    let maxBurst = 0;
    let maxCrouch = 0;
    for (let dt = 0; dt < ENTER_MS; dt += 50) {
      const s = at(dt);
      const c = actor(s, C);
      expect(c.phase).toBe("entering");
      expect(c.emotion).toBe("excited");
      maxOpen = Math.max(maxOpen, s.portal.open);
      maxBurst = Math.max(maxBurst, s.portal.burst);
      maxCrouch = Math.max(maxCrouch, c.crouch);
    }
    expect(maxOpen).toBeGreaterThan(0.95);
    expect(maxBurst).toBeGreaterThan(0.9);
    expect(maxCrouch).toBeGreaterThan(0.9);
    // Starts inside the portal, ends out on the floor; the portal is closed again.
    expect(actor(at(100), C)).toMatchObject({ x: PORTAL.x, z: PORTAL.z, emerge: 0 });
    expect(actor(at(ENTER_MS - 1), C).emerge).toBe(1);
    expect(at(ENTER_MS + 10).portal.open).toBe(0);
    expect(actor(at(ENTER_MS + 10), C).phase).not.toBe("entering");
  });

  it("on leave: the reverse, then gone", () => {
    const at = (dt: number) => choreograph(ROOM, members, events, T0 + 20_000 + dt);
    expect(actor(at(0), C).phase).toBe("leaving");
    let maxBurst = 0;
    for (let dt = 0; dt < LEAVE_MS; dt += 50) maxBurst = Math.max(maxBurst, at(dt).portal.burst);
    expect(maxBurst).toBeGreaterThan(0.9);
    const end = actor(at(LEAVE_MS - 1), C);
    expect(end.x).toBeCloseTo(PORTAL.x);
    expect(end.z).toBeCloseTo(PORTAL.z);
    expect(end.emerge).toBe(0);
    expect(actor(at(LEAVE_MS), C).phase).toBe("absent");
  });
});

describe("talking", () => {
  it("A messages B: A walks to B and talks with the kind's emotion; B listens; a bubble only over A", () => {
    const t0 = T0 + 6000;
    const dist = (t: number) => {
      const s = choreograph(ROOM, members, events, t);
      return Math.hypot(actor(s, A).x - actor(s, B).x, actor(s, A).z - actor(s, B).z);
    };
    expect(dist(t0 + 2500)).toBeCloseTo(0.6, 5);
    const s = choreograph(ROOM, members, events, t0 + 2500);
    expect(actor(s, A)).toMatchObject({
      phase: "talking",
      emotion: "happy",
      gesture: "talk",
      gestureAt: t0,
      bubble: true,
    });
    expect(actor(s, B)).toMatchObject({ phase: "listening", bubble: false, gesture: null });
    // They face each other.
    expect(actor(s, A).facing).toBe(actor(s, B).x >= actor(s, A).x ? 1 : -1);
    expect(actor(s, B).facing).toBe(actor(s, A).x >= actor(s, B).x ? 1 : -1);
    // After the talk A is back to its wander.
    expect(choreograph(ROOM, members, events, t0 + TALK_MS + 1).actors.find((a) => a.companionId === A)!.bubble).toBe(
      false,
    );
  });

  it("a message to everyone: the speaker talks in place", () => {
    const s = choreograph(ROOM, members, events, T0 + 15_000);
    expect(actor(s, B)).toMatchObject({ phase: "talking", emotion: "thinking", bubble: true });
  });

  it("a companion that isn't in the room never walks over or talks", () => {
    const s = choreograph(ROOM, members.slice(0, 2), [ev("x", C, "notice", T0, [A])], T0 + 2000);
    expect(actor(s, A).phase).not.toBe("listening");
    expect(s.actors.some((a) => a.companionId === C)).toBe(false);
  });
});
