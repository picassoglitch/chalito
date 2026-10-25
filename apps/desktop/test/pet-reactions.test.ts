import { describe, expect, it } from "vitest";
import { ActivityTracker, type Activity } from "@chalito/avatar";
import { AvatarDriver } from "@chalito/avatar-three";
import {
  PERK_QUIET_MS,
  PerkGate,
  mouseMayPlay,
  petReaction,
  playReaction,
  type ReactionInput,
} from "../src/pet/reactions.js";

const zero: Activity = { mode: "rest", done: 0, failed: 0, started: 0, messages: 0, alerts: 0 };
const react = (now: Partial<Activity>, o: Partial<ReactionInput> = {}) =>
  petReaction({ before: zero, now: { ...zero, ...now }, behaviour: "idle", quiet: false, playing: null, ...o });

describe("each event triggers its own move (pet state logic)", () => {
  it("task started → go, finished → hop, failed → slump, alert → glance, message → perk", () => {
    expect(react({ started: 1, mode: "working" })).toEqual({ action: "go", face: "happy", faceMs: 1500 });
    expect(react({ done: 1 })).toEqual({ action: "hop", face: "happy", faceMs: 2500 });
    expect(react({ failed: 1 })).toEqual({ action: "slump", face: "sad", faceMs: 3500 });
    expect(react({ alerts: 1 })?.action).toBe("glance");
    expect(react({ messages: 1 })?.action).toBe("perk");
    expect(react({})).toBeNull();
    expect(
      petReaction({ before: null, now: { ...zero, done: 3 }, behaviour: "idle", quiet: false, playing: null }),
    ).toBeNull();
  });

  it("when several land together the most telling one plays", () => {
    expect(react({ done: 1, messages: 1 })?.action).toBe("hop");
    expect(react({ started: 1, messages: 1 })?.action).toBe("go");
    expect(react({ done: 1, failed: 1 })?.action).toBe("slump");
  });

  it("a smaller move never cuts a bigger one short; a bigger one may", () => {
    expect(react({ messages: 1 }, { playing: "hop" })).toBeNull();
    expect(react({ done: 1 }, { playing: "perk" })?.action).toBe("hop");
    expect(react({ messages: 1 }, { playing: "wave" })?.action).toBe("perk");
  });

  it("an alert adds nothing while an approval waits; nothing small cuts an escalation's call", () => {
    expect(react({ alerts: 1, mode: "needs_you" })).toBeNull();
    // Muted glance falls through to the next move.
    expect(react({ alerts: 1, messages: 1, mode: "needs_you" })?.action).toBe("perk");
    expect(react({ started: 1, mode: "needs_you" })?.action).toBe("go");
    for (const b of ["wave", "hop", "knock"] as const) {
      for (const a of [{ alerts: 1 }, { messages: 1 }, { started: 1 }]) expect(react(a, { behaviour: b })).toBeNull();
      expect(react({ done: 1, messages: 1 }, { behaviour: b })?.action).toBe("hop");
    }
    expect(react({ alerts: 1 }, { behaviour: "glance" })?.action).toBe("glance");
  });

  it("Do Not Disturb and quiet hours mute the attention moves, not finish and fail", () => {
    for (const a of [{ started: 1 }, { alerts: 1 }, { messages: 1 }]) expect(react(a, { quiet: true })).toBeNull();
    expect(react({ done: 1 }, { quiet: true })?.action).toBe("hop");
    expect(react({ done: 1, alerts: 1 }, { quiet: true })?.action).toBe("hop");
    expect(react({ started: 1, messages: 1, failed: 1 }, { quiet: true })?.action).toBe("slump");
  });

  it("the move survives its face (a happy face's nod used to replace the finish hop)", () => {
    for (const r of [react({ done: 1 }), react({ started: 1 })]) {
      const d = new AvatarDriver({ seed: 1 });
      playReaction(r!, 100, (face, now) => d.setEmotion({ tag: face, intensity: 0.9 }, now), d);
      expect(d.actionAt(150)).toBe(r!.action);
    }
  });

  it("end to end from the live store's shapes: a new reply perks it up, a new session says let's go", () => {
    const tr = new ActivityTracker();
    const a0 = tr.update([{ sid: "s1", state: "idle", updatedAt: 1 }], 0, { now: 1000, events: {}, notifications: [] });
    const a1 = tr.update([{ sid: "s1", state: "running", updatedAt: 1100 }], 0, { events: {}, notifications: [] });
    expect(petReaction({ before: a0, now: a1, behaviour: "idle", quiet: false, playing: null })?.action).toBe("go");
    const a2 = tr.update([{ sid: "s1", state: "running" }], 0, {
      events: { s1: [{ eid: "e1", t: 1200, type: "message.assistant" }] },
    });
    expect(petReaction({ before: a1, now: a2, behaviour: "idle", quiet: false, playing: null })?.action).toBe("perk");
  });
});

describe("perks at replies stay rare (owner, 2026-10-25)", () => {
  it("only the first reply after 60 s without any perks; a steady stream never does", () => {
    const g = new PerkGate();
    expect(g.reply(0, false)).toBe(true);
    g.perked(0);
    expect(g.reply(5_000, false)).toBe(false);
    // Replies every 30 s keep the burst alive past 60 s: still no second perk.
    expect(g.reply(35_000, false)).toBe(false);
    expect(g.reply(65_000, false)).toBe(false);
    expect(g.reply(65_000 + PERK_QUIET_MS, false)).toBe(true);
  });

  it("at most one per 60 s, and none while the panel is focused", () => {
    const g = new PerkGate();
    expect(g.reply(0, true)).toBe(false); // reading the panel: no perk, and the burst has begun
    expect(g.reply(10_000, false)).toBe(false);
    expect(g.reply(10_000 + PERK_QUIET_MS, false)).toBe(true);
    g.perked(10_000 + PERK_QUIET_MS);
    const h = new PerkGate();
    h.perked(100_000);
    expect(h.reply(120_000, false)).toBe(false);
  });

  it("a turned-down perk is dropped; finishes, failures and other moves are unchanged", () => {
    expect(react({ messages: 1 }, { perkOk: false })).toBeNull();
    expect(react({ done: 1, messages: 1 }, { perkOk: false })?.action).toBe("hop");
    expect(react({ failed: 1 }, { perkOk: false })?.action).toBe("slump");
    expect(react({ messages: 1 })?.action).toBe("perk");
  });
});

describe("mouse moves follow the reaction rules", () => {
  const base = { playing: null, behaviour: "idle" as const, quiet: false };

  it("never over an escalation's call", () => {
    for (const behaviour of ["wave", "hop", "knock"] as const)
      for (const a of ["walk", "notice", "poke"] as const) expect(mouseMayPlay(a, { ...base, behaviour })).toBe(false);
  });

  it("never cut a bigger move short; same-size moves may follow each other", () => {
    for (const playing of ["slump", "hop", "go", "glance", "perk"] as const)
      expect(mouseMayPlay("notice", { ...base, playing })).toBe(false);
    expect(mouseMayPlay("walk", { ...base, playing: "walk" })).toBe(true);
    expect(mouseMayPlay("poke", { ...base, playing: "wave" })).toBe(true);
  });

  it("the walk and the hover notice are muted in DND and quiet hours; a poke still answers the click", () => {
    expect(mouseMayPlay("walk", { ...base, quiet: true })).toBe(false);
    expect(mouseMayPlay("notice", { ...base, quiet: true })).toBe(false);
    expect(mouseMayPlay("poke", { ...base, quiet: true })).toBe(true);
  });
});
