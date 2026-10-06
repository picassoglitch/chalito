/**
 * Browser side of scripts/render-showcase.ts: the real runtime (AvatarDriver + CreatureBinding +
 * the card avatar) on a fixed-size canvas. Bundled with esbuild; the Node side calls
 * `__showcase.load(job)` then `__showcase.frame(t)` for each frame and reads back a PNG.
 */
import * as THREE from "three";
import { AvatarDriver, CreatureBinding, createCardAvatar, type CardItem, type SkinId } from "@chalito/avatar-three";
import { EMOTION_DRAWING } from "@chalito/roster";
import { RoomScene, type RoomSceneMember, type SceneEvent } from "@chalito/scene";
import type { Beat } from "./scenes.js";

export interface PageActor {
  x: number;
  spec: { width: number; height: number; shadow?: { x: number; y: number; rx: number; ry: number; opacity: number } };
  drawings: Record<string, string>;
  items: { url: string; placed: CardItem["placed"] }[];
  /** A catalog skin's effect, if the actor wears one. */
  skin?: SkinId;
  beats: Beat[];
}
export interface PageJob {
  w: number;
  h: number;
  seed: number;
  actors: PageActor[];
  /** A RoomScene job: members and events at epoch `base` + scene time. */
  room?: { roomId: string; base: number; members: RoomSceneMember[]; events: SceneEvent[] };
}

interface Live {
  driver: AvatarDriver;
  binding: CreatureBinding;
  setDrawing: (d: string) => void;
  tick: (seconds: number) => void;
  beats: Beat[];
  next: number;
}

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let live: Live[] = [];
let room: { scene: RoomScene; base: number } | null = null;

const loader = new THREE.TextureLoader();
const load = (url: string) => loader.loadAsync(url);

const showcase = {
  async load(job: PageJob) {
    renderer?.dispose();
    room?.scene.dispose();
    room = null;
    // A fresh canvas per job: a WebGL context can't be shared between two renderers.
    document.querySelector("canvas")?.replaceWith(document.createElement("canvas"));
    const canvas = document.querySelector("canvas")!;
    if (job.room) {
      canvas.style.width = `${job.w}px`;
      canvas.style.height = `${job.h}px`;
      const scene = new RoomScene({
        canvas,
        roomId: job.room.roomId,
        assetBase: "/roster/",
        quality: "alto",
        preserveDrawingBuffer: true,
      });
      scene.setMembers(job.room.members);
      scene.pushEvents(job.room.events);
      await scene.ready();
      room = { scene, base: job.room.base };
      return;
    }
    canvas.width = job.w;
    canvas.height = job.h;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(job.w, job.h, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    // Frame the cards: one card is ~1 unit tall; wider scenes pull back a little.
    const aspect = job.w / job.h;
    camera = new THREE.PerspectiveCamera(30, aspect, 0.1, 20);
    const dist = job.actors.length > 1 ? 3.4 : 2.6;
    camera.position.set(0, 0.55, dist);
    camera.lookAt(0, 0.52, 0);
    live = [];
    for (const a of job.actors) {
      const drawings: Record<string, THREE.Texture> = {};
      for (const [k, url] of Object.entries(a.drawings)) drawings[k] = await load(url);
      const items: CardItem[] = [];
      for (const it of a.items) items.push({ placed: it.placed, texture: await load(it.url) });
      const card = createCardAvatar(a.spec, drawings, items, 1);
      card.setSkin(a.skin ?? null);
      scene.add(card.root);
      live.push({
        driver: new AvatarDriver({ seed: job.seed + live.length }),
        binding: new CreatureBinding(card.root, { x: a.x, y: 0, z: 0 }),
        setDrawing: card.setDrawing,
        tick: card.tick,
        beats: [...a.beats].sort((p, q) => p.at - q.at),
        next: 0,
      });
    }
  },

  /** Renders the scene at time `t` (ms, non-decreasing) and returns the canvas as a PNG data URL. */
  frame(t: number): string {
    if (room) {
      room.scene.renderAt(room.base + t);
      return document.querySelector("canvas")!.toDataURL("image/png");
    }
    for (const l of live) {
      while (l.next < l.beats.length && l.beats[l.next]!.at <= t) {
        const b = l.beats[l.next++]!;
        if (b.sleepy !== undefined) l.driver.setSleepy(b.sleepy);
        if (b.emotion) {
          l.driver.setEmotion(b.emotion, b.at);
          l.setDrawing(EMOTION_DRAWING[b.emotion.tag]);
        }
        if (b.gesture) l.driver.playGesture(b.gesture, b.at);
      }
      l.binding.apply(l.driver.frame(t));
      l.tick(t / 1000);
    }
    renderer!.render(scene!, camera!);
    return renderer!.domElement.toDataURL("image/png");
  },
};

(window as unknown as { __showcase: typeof showcase }).__showcase = showcase;
