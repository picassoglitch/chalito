import { describe, expect, it } from "vitest";
import { ACTION_MS, RETRO_HOLD_MS, creaturePose, fidgetAt } from "@chalito/avatar";
import { AvatarDriver } from "../src/driver.js";
import { RetroStepper, stepFrame } from "../src/retro.js";

describe("retro frames from the driver", () => {
  it("holds the body and rig for a hold, keeps blinks and the mouth live", () => {
    const d = new AvatarDriver({ seed: 3 });
    d.setMode("working");
    const s = new RetroStepper();
    const first = s.step(1000, d.frame(1000));
    const live = d.frame(1040);
    live.rig = { ...live.rig, lids: 1, mouth: 0.5 };
    live.expressions = { ...live.expressions, blink: 1 };
    const held = s.step(1040, live);
    expect(held.creature).toBe(first.creature);
    expect(held.rig.armL).toBe(first.rig.armL);
    expect(held.rig.lids).toBe(1);
    expect(held.rig.mouth).toBe(0.5);
    expect(held.expressions.blink).toBe(1);
    const next = d.frame(1000 + RETRO_HOLD_MS * 1.5);
    expect(s.step(1000 + RETRO_HOLD_MS * 1.5, next)).toBe(next);
  });

  it("a typing pet drawn at 60 FPS changes pose only 8–12 times a second", () => {
    const d = new AvatarDriver({ seed: 1 });
    d.setMode("working");
    const s = new RetroStepper();
    let changes = 0;
    let prev: string | null = null;
    for (let t = 5000; t < 6000; t += 1000 / 60) {
      const f = s.step(t, d.frame(t));
      const pose = JSON.stringify([f.creature, f.rig.armL, f.rig.armR, f.rig.head]);
      if (prev !== null && pose !== prev) changes++;
      prev = pose;
    }
    expect(changes).toBeGreaterThanOrEqual(8);
    expect(changes).toBeLessThanOrEqual(12);
  });

  it("is a pure step: the same inputs give the same result", () => {
    const d = new AvatarDriver({ seed: 1 });
    const f = d.frame(0);
    expect(stepFrame(null, 10, f)).toEqual(stepFrame(null, 10, f));
  });
});

describe("driver: what's playing, and fidgets only at rest", () => {
  it("reports the action playing until it ends", () => {
    const d = new AvatarDriver({ seed: 1 });
    expect(d.actionAt(0)).toBeNull();
    d.playAction("slump", 100);
    expect(d.actionAt(100 + ACTION_MS.slump - 1)).toBe("slump");
    expect(d.actionAt(100 + ACTION_MS.slump)).toBeNull();
  });

  it("the body fidget shows at rest only: not working, asleep or during an action", () => {
    let t = 0;
    while (fidgetAt(t)?.kind !== "look_left" || fidgetAt(t)!.u < 0.2) t += 50;
    const tiltAt = (setup: (d: AvatarDriver) => void) => {
      const d = new AvatarDriver({ seed: 1 });
      setup(d);
      d.frame(t - 50);
      return d.frame(t).creature.tilt[2];
    };
    const rest = tiltAt(() => undefined);
    const base = creaturePose({ tag: "neutral", intensity: 1 }, t).tilt[2];
    expect(rest - base).toBeCloseTo(3, 6);
    expect(tiltAt((d) => d.setSleepy(true)) - base).toBeCloseTo(0, 6);
    expect(tiltAt((d) => d.setMode("working")) - base).toBeCloseTo(0, 6);
    expect(tiltAt((d) => d.playAction("nod", t - 100)) - base).toBeCloseTo(0, 6);
  });

  it("never lifts off at rest over a minute (no jumping at rest, 2026-10-19)", () => {
    const d = new AvatarDriver({ seed: 1 });
    let maxY = 0;
    for (let t = 0; t < 60_000; t += 50) maxY = Math.max(maxY, d.frame(t).creature.offsetY);
    expect(maxY).toBeLessThan(0.006);
  });
});
