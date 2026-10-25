import { describe, expect, it } from "vitest";
import { ActivityTracker, activityActions } from "../src/activity.js";
import {
  ACTION_MS,
  CREATURE_ACTIONS,
  NEEDS_YOU_BOUNCES,
  actionLayer,
  composeCreature,
  fidgetAt,
  modeLayer,
  type CreatureLayer,
} from "../src/actions.js";
import { creaturePose } from "../src/gestures.js";
import { RIG_REST, parseRig, rigFiles, rigPose, rigSrcFor, type RigInput } from "../src/rig.js";

const vol = (l: CreatureLayer) => l.scale[0] * l.scale[1] * l.scale[2];

describe("modes and actions (movement only to show something)", () => {
  it("rest adds nothing; working and needs_you keep the volume", () => {
    expect(modeLayer("rest", 1234)).toEqual({ offsetY: 0, scale: [1, 1, 1], tilt: [0, 0, 0] });
    for (const m of ["working", "needs_you"] as const)
      for (let t = 0; t < 8000; t += 17) expect(vol(modeLayer(m, t))).toBeCloseTo(1, 6);
  });

  it("needs_you bounces a couple of times when it starts, then only leans in", () => {
    const bounces = (from: number, to: number) => {
      let n = 0;
      let wasUp = false;
      for (let t = from; t < to; t += 10) {
        const up = modeLayer("needs_you", t).offsetY > 0.001;
        if (up && !wasUp) n++;
        wasUp = up;
      }
      return n;
    };
    expect(bounces(0, 3.2 * NEEDS_YOU_BOUNCES * 1000)).toBe(NEEDS_YOU_BOUNCES);
    expect(bounces(3.2 * NEEDS_YOU_BOUNCES * 1000, 120_000)).toBe(0);
    // Still leaning toward the person while it waits.
    expect(modeLayer("needs_you", 60_000).tilt[0]).toBeLessThan(0);
  });

  for (const a of CREATURE_ACTIONS)
    it(`${a}: starts and ends at rest, keeps the volume, then is done`, () => {
      const start = actionLayer(a, 0);
      expect(start.offsetY).toBeCloseTo(0, 6);
      const end = actionLayer(a, ACTION_MS[a]);
      expect(end.done).toBe(true);
      expect(end.offsetY).toBe(0);
      for (let t = 0; t < ACTION_MS[a]; t += 7) {
        const l = actionLayer(a, t);
        expect(l.done).toBe(false);
        expect(vol(l)).toBeCloseTo(1, 6);
      }
    });

  it("a finished task hops clearly; an error sinks", () => {
    const peak = Math.max(...Array.from({ length: 70 }, (_, i) => actionLayer("hop", i * 10).offsetY));
    expect(peak).toBeGreaterThan(0.08);
    expect(actionLayer("slump", ACTION_MS.slump / 2).offsetY).toBeLessThan(0);
  });

  it("layers compose over the rest pose", () => {
    const rest = creaturePose({ tag: "neutral", intensity: 1 }, 0);
    const c = composeCreature(rest, [modeLayer("working", 0), actionLayer("hop", 400)]);
    expect(c.offsetY).toBeGreaterThan(rest.offsetY);
    expect(c.tilt[0]).toBeCloseTo(rest.tilt[0] + 4, 6);
    expect(c.lookAtWeight).toBe(rest.lookAtWeight);
  });
});

const input = (o: Partial<RigInput> = {}): RigInput => ({
  tMs: 0,
  mode: "rest",
  action: null,
  blink: 0,
  mouth: 0,
  gaze: { yaw: 0, pitch: 0 },
  sleepy: false,
  ...o,
});

describe("rig pose", () => {
  it("at rest the arms hang (a breath of movement) and the eyes follow the blink", () => {
    for (let t = 0; t < 10_000; t += 50) {
      if (fidgetAt(t)) continue; // the occasional look-around has its own test (retro.test.ts)
      const p = rigPose(input({ tMs: t }));
      expect(p.armL).toBeLessThan(5);
      expect(p.armR).toBeLessThan(5);
      expect(Math.abs(p.head)).toBeLessThan(3);
    }
    expect(rigPose(input({ blink: 1 })).lids).toBe(1);
    expect(rigPose(input({ blink: 0 })).lids).toBe(0);
  });

  it("the head turns toward where it looks, within limits", () => {
    expect(rigPose(input({ gaze: { yaw: 30, pitch: 0 } })).head).toBeLessThan(rigPose(input()).head);
    expect(Math.abs(rigPose(input({ gaze: { yaw: 400, pitch: 0 } })).head)).toBeLessThanOrEqual(6.3);
  });

  it("wave raises the right arm high and brings it back", () => {
    const at = (ms: number) => rigPose(input({ action: { name: "wave", elapsedMs: ms } }));
    expect(at(ACTION_MS.wave / 2).armR).toBeGreaterThan(90);
    expect(at(0).armR).toBeLessThan(5);
    expect(at(ACTION_MS.wave).armR).toBeLessThan(5);
  });

  it("working types (both arms in, alternating); needs_you points now and then", () => {
    const w = rigPose(input({ mode: "working", tMs: 1000 / 12 }));
    expect(w.armL).toBeGreaterThan(8);
    expect(w.armR).toBeGreaterThanOrEqual(8);
    let pointing = 0;
    for (let t = 0; t < 8000; t += 20) if (rigPose(input({ mode: "needs_you", tMs: t })).armR > 50) pointing++;
    expect(pointing).toBeGreaterThan(0);
    expect(pointing).toBeLessThan(8000 / 20 / 2);
  });

  it("an error slumps: arms drop, head down, eyes half shut", () => {
    const p = rigPose(input({ mode: "working", tMs: 500, action: { name: "slump", elapsedMs: ACTION_MS.slump / 2 } }));
    expect(p.armL).toBeLessThan(1);
    expect(p.headDrop).toBeGreaterThan(0.01);
    expect(p.lids).toBeGreaterThan(0.5);
  });

  it("the mouth opens with the voice", () => {
    expect(rigPose(input({ mouth: 0.7 })).mouth).toBeCloseTo(0.7);
    expect(rigPose(input({ mouth: 3 })).mouth).toBe(1);
    expect(RIG_REST.mouth).toBe(0);
  });
});

describe("rig spec", () => {
  const good = {
    v: 1,
    parts: [
      { id: "body", src: "rig-body.webp", pivot: [0.5, 0.97], z: 0 },
      { id: "armR", src: "rig-arm-r.webp", pivot: [0.62, 0.55], z: 1 },
      { id: "head", src: { neutral: "rig-head-neutral.webp", happy: "rig-head-happy.webp" }, pivot: [0.5, 0.48], z: 2 },
      { id: "lids", src: "rig-lids.webp", parent: "head", pivot: [0.5, 0.48], z: 3, only: ["neutral"] },
    ],
  };

  it("parses a good rig and lists its files once", () => {
    const r = parseRig(good)!;
    expect(r.parts.map((p) => p.id)).toEqual(["body", "armR", "head", "lids"]);
    expect(rigFiles(r).sort()).toEqual(
      ["rig-arm-r.webp", "rig-body.webp", "rig-head-happy.webp", "rig-head-neutral.webp", "rig-lids.webp"].sort(),
    );
  });

  it("picks each part's image by drawing; `only` hides it elsewhere", () => {
    const r = parseRig(good)!;
    const head = r.parts.find((p) => p.id === "head")!;
    const lids = r.parts.find((p) => p.id === "lids")!;
    expect(rigSrcFor(head, "happy")).toBe("rig-head-happy.webp");
    expect(rigSrcFor(head, "surprised")).toBe("rig-head-neutral.webp");
    expect(rigSrcFor(lids, "neutral")).toBe("rig-lids.webp");
    expect(rigSrcFor(lids, "happy")).toBeNull();
  });

  it("refuses anything malformed (the card then moves as one piece)", () => {
    const bad = (patch: (g: typeof good) => unknown) => parseRig(patch(structuredClone(good)));
    expect(parseRig(null)).toBeNull();
    expect(bad((g) => ({ ...g, v: 2 }))).toBeNull();
    expect(bad((g) => ({ ...g, parts: g.parts.filter((p) => p.id !== "head") }))).toBeNull();
    expect(bad((g) => ({ ...g, parts: [...g.parts, g.parts[0]] }))).toBeNull();
    expect(bad((g) => (((g.parts[0] as { src: string }).src = "../../etc/passwd"), g))).toBeNull();
    expect(bad((g) => (((g.parts[0] as { src: string }).src = "https://x.test/a.webp"), g))).toBeNull();
    expect(bad((g) => ((g.parts[1]!.pivot = [2, 0]), g))).toBeNull();
    expect(bad((g) => (((g.parts[3] as { parent: string }).parent = "armL"), g))).toBeNull();
  });
});

describe("activity from the person's sessions", () => {
  it("the first look only learns; later finishes and failures count once", () => {
    const tr = new ActivityTracker();
    const a0 = tr.update(
      [
        { sid: "a", state: "completed" },
        { sid: "b", state: "running" },
      ],
      0,
    );
    expect(a0).toEqual({ mode: "working", done: 0, failed: 0, started: 0, messages: 0, alerts: 0 });
    const a1 = tr.update(
      [
        { sid: "a", state: "completed" },
        { sid: "b", state: "completed" },
      ],
      0,
    );
    expect(a1).toMatchObject({ mode: "rest", done: 1, failed: 0 });
    expect(activityActions(a0, a1)).toEqual(["hop"]);
    const a2 = tr.update(
      [
        { sid: "a", state: "completed" },
        { sid: "b", state: "completed" },
      ],
      0,
    );
    expect(activityActions(a1, a2)).toEqual([]);
    const a3 = tr.update([{ sid: "c", state: "failed", updatedAt: Date.now() + 60_000 }], 0);
    expect(a3.failed).toBe(1);
    expect(activityActions(a2, a3)).toEqual(["slump"]);
  });

  it("an answer waiting wins over busy", () => {
    const tr = new ActivityTracker();
    expect(tr.update([{ sid: "a", state: "running" }], 1).mode).toBe("needs_you");
    expect(tr.update([{ sid: "a", state: "waiting_approval" }], 0).mode).toBe("needs_you");
    expect(tr.update([], 0).mode).toBe("rest");
    expect(activityActions(null, { mode: "rest", done: 3, failed: 1, started: 2, messages: 4, alerts: 1 })).toEqual([]);
  });
});
