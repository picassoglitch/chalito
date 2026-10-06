import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { RoomScene, RoomWorld, RENDER_DEFAULTS, choreograph, loadCardAssets, type SceneEvent } from "../src/index.js";
import { CARD, fakeCanvas, fakeRenderer, fakeTexture, sceneOpts } from "./fakes.js";

const A = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "chl_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = 1_760_000_000_000;
const members = [
  { companionId: A, avatar: "chalito" },
  {
    companionId: B,
    avatar: "luna",
    cosmetics: [
      {
        slot: "head" as const,
        art: "cosmetics/flower_crown.webp",
        card: { width: 0.44, pivot: [0.5, 0.62] as [number, number] },
      },
    ],
  },
];
const enterB: SceneEvent = { eid: "e1", fromCompanionId: B, to: [], kind: "enter", t: T0 };

describe("RoomScene", () => {
  it("plays the portal on enter (scene graph)", async () => {
    const scene = new RoomScene(sceneOpts());
    scene.setMembers(members);
    scene.pushEvents([enterB]);
    await scene.ready();
    // RoomScene's world is private: mirror it with a world of our own, fed the scene's states.
    const w = new RoomWorld(RENDER_DEFAULTS.levels.medio);
    w.addActor(B, { spec: CARD, drawings: { neutral: fakeTexture("n"), happy: fakeTexture("h") }, items: [] });
    const portal = w.scene.getObjectByName("portal")!;
    const burst = w.scene.getObjectByName("portal-burst") as THREE.Mesh;
    w.update(choreograph("room_fam1", members, [enterB], T0 - 1), T0 - 1);
    expect(portal.visible).toBe(false);
    let maxScale = 0;
    let maxBurst = 0;
    for (let dt = 0; dt < 2600; dt += 50) {
      const s = scene.renderAt(T0 + dt);
      w.update(s, T0 + dt);
      maxScale = Math.max(maxScale, portal.visible ? portal.scale.x : 0);
      maxBurst = Math.max(maxBurst, (burst.material as THREE.MeshBasicMaterial).opacity);
    }
    expect(maxScale).toBeGreaterThan(0.95);
    expect(maxBurst).toBeGreaterThan(0.4);
    w.update(scene.renderAt(T0 + 3000), T0 + 3000);
    expect(portal.visible).toBe(false);
    expect(w.scene.getObjectByName(`actor:${B}`)!.visible).toBe(true);
  });

  it("two viewers, events arriving in different orders and at different times, draw the same positions", async () => {
    const events: SceneEvent[] = [
      enterB,
      { eid: "e2", fromCompanionId: A, to: [B], kind: "event_proposal", t: T0 + 5000 },
      { eid: "e3", fromCompanionId: B, to: [A], kind: "ack", t: T0 + 9000 },
    ];
    const v1 = new RoomScene(sceneOpts());
    const v2 = new RoomScene(sceneOpts());
    v1.setMembers(members);
    v2.setMembers([...members].reverse());
    v1.pushEvents(events);
    v2.pushEvents([events[2]!]);
    v2.pushEvents([events[0]!, events[1]!, events[2]!]);
    for (let t = T0; t < T0 + 30_000; t += 333) expect(v2.renderAt(t)).toEqual(v1.renderAt(t));
  });

  it("only event metadata reaches the scene: extra fields (content) are dropped", () => {
    const scene = new RoomScene(sceneOpts());
    scene.setMembers(members);
    scene.pushEvents([{ ...enterB, text: "secret", body: { kind: "notice", text: "secret" } } as SceneEvent]);
    const s = scene.renderAt(T0 + 100);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("no input path emits movement: no listeners, no movement API", async () => {
    const canvas = fakeCanvas();
    const added: string[] = [];
    const g = globalThis as unknown as { addEventListener?: unknown };
    const prev = g.addEventListener;
    g.addEventListener = (type: string) => added.push(type);
    try {
      const scene = new RoomScene(sceneOpts({ canvas: canvas as unknown as HTMLCanvasElement }));
      scene.setMembers(members);
      scene.pushEvents([enterB]);
      scene.start();
      await scene.ready();
      scene.renderAt(T0);
      scene.stop();
      scene.dispose();
    } finally {
      g.addEventListener = prev;
    }
    expect(canvas.listeners).toEqual([]);
    expect(added).toEqual([]);
    const api = Object.getOwnPropertyNames(RoomScene.prototype)
      .filter((n) => n !== "constructor")
      .sort();
    expect(api).toEqual(
      [
        "dispose",
        "frames",
        "level",
        "onQuality",
        "pushEvents",
        "quality",
        "ready",
        "renderAt",
        "setMembers",
        "setQuality",
        "start",
        "stop",
      ].sort(),
    );
    // And nothing in the package listens to pointers, keys, touch or the wheel.
    const src = join(__dirname, "../src");
    for (const f of readdirSync(src)) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text, f).not.toMatch(/addEventListener|onpointer|onmouse|onkey|ontouch|onwheel|onclick/i);
    }
  });

  it("quality: auto on a software renderer is bajo (impostors, no shadows); a fixed level is kept", async () => {
    const soft = new RoomScene(
      sceneOpts({ quality: "auto", createRenderer: () => fakeRenderer("Google SwiftShader").r }),
    );
    const seen: string[] = [];
    soft.onQuality((q) => seen.push(q));
    await Promise.resolve();
    expect(soft.level).toBe("bajo");
    expect(seen).toEqual(["bajo"]);
    const hw = new RoomScene(sceneOpts({ quality: "auto" }));
    expect(hw.level).toBe("alto"); // probing at alto first
    hw.setQuality("medio");
    expect(hw.level).toBe("medio");
  });

  it("bajo hides the contact shadow, alto shows it; cosmetics load onto the card", async () => {
    const w = new RoomWorld(RENDER_DEFAULTS.levels.bajo);
    w.addActor(A, { spec: CARD, drawings: { neutral: fakeTexture("n") }, items: [] });
    expect(w.scene.getObjectByName("shadow")!.visible).toBe(false);
    w.setLevel(RENDER_DEFAULTS.levels.alto);
    expect(w.scene.getObjectByName("shadow")!.visible).toBe(true);

    const urls: string[] = [];
    const scene = new RoomScene(sceneOpts({ loadTexture: async (u) => (urls.push(u), fakeTexture(u)) }));
    scene.setMembers(members);
    await scene.ready();
    expect(urls).toContain("/roster/cosmetics/flower_crown.webp");
    expect(urls).toContain("/roster/assets/luna/h.webp");
  });

  it("a skin travels with the member: loaded from the catalog entry, drawn over the card, animated", async () => {
    const assets = await loadCardAssets(
      "/roster/",
      "luna",
      [
        { slot: "skin", skin: "galaxy" },
        { slot: "head", art: "cosmetics/flower_crown.webp", card: { width: 0.44, pivot: [0.5, 0.62] } },
      ],
      { fetchJson: async () => CARD, loadTexture: async (u) => fakeTexture(u) },
    );
    expect(assets.skin).toBe("galaxy");
    expect(assets.items).toHaveLength(1); // the skin is no item: nothing to load or place
    const bad = await loadCardAssets("/roster/", "luna", [{ slot: "skin", skin: "lava" as never }], {
      fetchJson: async () => CARD,
      loadTexture: async (u) => fakeTexture(u),
    });
    expect(bad.skin).toBeNull();

    const w = new RoomWorld(RENDER_DEFAULTS.levels.medio);
    w.addActor(B, assets);
    const body = w.scene.getObjectByName(`actor:${B}`)!.getObjectByName("body") as THREE.Mesh;
    const mat = body.material as THREE.ShaderMaterial;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    w.update(choreograph("room_fam1", members, [enterB], T0 + 3000), T0 + 3000);
    expect(mat.uniforms.uTime!.value).toBeCloseTo(((T0 + 3000) / 1000) % 3600, 3);
    // Emotion swaps keep it.
    w.update(choreograph("room_fam1", members, [enterB], T0 + 9000), T0 + 9000);
    expect(body.material).toBe(mat);
  });

  it("changing only the skin reloads the member's card", async () => {
    const loads: string[] = [];
    const scene = new RoomScene(sceneOpts({ fetchJson: async (u) => (loads.push(u), CARD) }));
    const luna = (skin: "gold" | "neon") => [
      { companionId: B, avatar: "luna", cosmetics: [{ slot: "skin" as const, skin }] },
    ];
    scene.setMembers(luna("gold"));
    await scene.ready();
    scene.setMembers(luna("gold"));
    await scene.ready();
    expect(loads).toHaveLength(1);
    scene.setMembers(luna("neon"));
    await scene.ready();
    expect(loads).toHaveLength(2);
  });

  it("the speech bubble shows over the speaker only", () => {
    const w = new RoomWorld(RENDER_DEFAULTS.levels.medio);
    for (const m of members)
      w.addActor(m.companionId, { spec: CARD, drawings: { neutral: fakeTexture("n") }, items: [] });
    const ev: SceneEvent = { eid: "m", fromCompanionId: A, to: [B], kind: "notice", t: T0 };
    w.update(choreograph("room_fam1", members, [ev], T0 + 2500), T0 + 2500);
    const bubble = (id: string) => w.scene.getObjectByName(`actor:${id}`)!.getObjectByName("bubble")!;
    expect(bubble(A).visible).toBe(true);
    expect(bubble(B).visible).toBe(false);
  });
});
