import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Level } from "@chalito/protocol";
import { BehaviourMachine, behaviourFor, effectiveLevel, type BehaviourContext } from "../src/behaviour.js";

const base: BehaviourContext = { level: null, fullscreen: false, dnd: false, quietHours: false, lowEnergy: false };
const at = (o: Partial<BehaviourContext>) => behaviourFor({ ...base, ...o });

const ctxArb = fc.record({
  level: fc.constantFrom<Level | null>(null, "L0", "L1", "L2", "L3", "L4"),
  fullscreen: fc.boolean(),
  dnd: fc.boolean(),
  quietHours: fc.boolean(),
  lowEnergy: fc.boolean(),
  acked: fc.boolean(),
});

describe("L0–L4 behaviour", () => {
  it("idle → glance → wave at the edge → hop near the cursor → centre knock", () => {
    expect(at({ level: null })).toMatchObject({ state: "idle", anchor: "home", requestFocus: false });
    expect(at({ level: "L0" })).toMatchObject({ state: "idle", anchor: "home" });
    expect(at({ level: "L1" })).toMatchObject({ state: "glance", anchor: "home", gesture: "glance" });
    expect(at({ level: "L2" })).toMatchObject({ state: "wave", anchor: "edge", gesture: "wave" });
    expect(at({ level: "L3" })).toMatchObject({ state: "hop", anchor: "near_cursor", gesture: "hop" });
    expect(at({ level: "L4" })).toMatchObject({ state: "knock", anchor: "center", requestFocus: true });
  });

  it("rest poses: sleepy in quiet hours, tired (yawning) when out of credits", () => {
    expect(at({ quietHours: true })).toMatchObject({ state: "sleepy" });
    expect(at({ lowEnergy: true })).toMatchObject({ state: "tired", gesture: "yawn" });
    expect(at({ quietHours: true, lowEnergy: true }).state).toBe("sleepy");
  });

  it("damping: DND and quiet hours hold L0–L3 at rest, fullscreen at a glance; L4 always passes", () => {
    expect(at({ level: "L3", dnd: true })).toMatchObject({ state: "idle", damped: true, effectiveLevel: "L0" });
    expect(at({ level: "L3", quietHours: true })).toMatchObject({ state: "sleepy", damped: true });
    expect(at({ level: "L3", fullscreen: true })).toMatchObject({
      state: "glance",
      damped: true,
      effectiveLevel: "L1",
    });
    expect(at({ level: "L1", fullscreen: true })).toMatchObject({ state: "glance", damped: false });
    expect(at({ level: "L4", fullscreen: true, dnd: true, quietHours: true })).toMatchObject({
      state: "knock",
      requestFocus: true,
      damped: false,
    });
  });

  it("property: never steals focus below L4", () => {
    fc.assert(
      fc.property(ctxArb, (ctx) => {
        const o = behaviourFor(ctx);
        expect(o.requestFocus).toBe(o.effectiveLevel === "L4");
      }),
    );
  });

  it("property: quiet hours / DND never animate above L0, fullscreen never above L1 (unless L4)", () => {
    const rank = (l: Level | null) => (l ? Number(l[1]) : -1);
    fc.assert(
      fc.property(ctxArb, (ctx) => {
        const { level } = effectiveLevel(ctx);
        if (ctx.level === "L4") return void expect(level).toBe("L4");
        if (ctx.quietHours || ctx.dnd) expect(rank(level)).toBeLessThanOrEqual(0);
        else if (ctx.fullscreen) expect(rank(level)).toBeLessThanOrEqual(1);
        else expect(level).toBe(ctx.level);
      }),
    );
  });

  it("property (stateful): over any sequence of contexts the machine only asks for focus at L4", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(ctxArb, fc.integer({ min: 0, max: 4000 })), { maxLength: 60 }), (steps) => {
        const m = new BehaviourMachine(2500);
        let now = 0;
        for (const [ctx, dt] of steps) {
          now += dt;
          const o = m.update(ctx, now);
          if (o.requestFocus) expect(effectiveLevel(ctx).level).toBe("L4");
        }
      }),
    );
  });
});

describe("BehaviourMachine dwell and ack", () => {
  it("escalates at once, de-escalates only after the dwell, and an ack rests immediately", () => {
    const m = new BehaviourMachine(2500);
    expect(m.update({ ...base, level: "L1" }, 0).state).toBe("glance");
    expect(m.update({ ...base, level: "L3" }, 100).state).toBe("hop");
    // The level drops right away: the pet keeps hopping a little longer (no flicker)…
    expect(m.update({ ...base, level: "L1" }, 500).state).toBe("hop");
    // …then follows after the dwell.
    expect(m.update({ ...base, level: "L1" }, 2700).state).toBe("glance");
    expect(m.update({ ...base, level: "L4" }, 2800)).toMatchObject({ state: "knock", requestFocus: true });
    // Held knock after the level fell: no focus request any more.
    expect(m.update({ ...base, level: "L2" }, 2900)).toMatchObject({ state: "knock", requestFocus: false });
    expect(m.update({ ...base, level: "L2", acked: true }, 3000)).toMatchObject({ state: "idle", requestFocus: false });
  });
});
