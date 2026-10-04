import * as THREE from "three";
import { FrameLoop, browserHost, type LoopHost } from "@chalito/avatar-three";
import type { CardPlacement } from "@chalito/roster";
import type { CosmeticSlot } from "@chalito/protocol";
import { choreograph, type SceneEvent, type SceneMember, type SceneState } from "./choreography.js";
import {
  RENDER_DEFAULTS,
  pickQuality,
  isSoftwareRenderer,
  type QualityLevel,
  type RenderQuality,
  type RenderSettings,
} from "./quality.js";
import { loadCardAssets } from "./card-assets.js";
import { RoomWorld } from "./world.js";

/** A cosmetic a member wears (from the store catalog): its art path in @chalito/roster and placement. */
export interface SceneCosmetic {
  slot: CosmeticSlot;
  /** "cosmetics/<id>.webp" */
  art: string;
  card: CardPlacement;
}

export interface RoomSceneMember extends SceneMember {
  cosmetics?: readonly SceneCosmetic[];
}

/** The bits of WebGLRenderer the scene uses (injectable for tests). */
export type SceneRenderer = Pick<
  THREE.WebGLRenderer,
  "setPixelRatio" | "setSize" | "render" | "dispose" | "setClearColor" | "getContext"
> & { shadowMap: { enabled: boolean }; outputColorSpace: string };

export interface RoomSceneOptions {
  canvas: HTMLCanvasElement;
  roomId: string;
  /** URL prefix where @chalito/roster's assets/ and cosmetics/ are served, e.g. "/roster/". */
  assetBase: string;
  quality?: RenderQuality;
  /** Epoch ms; server-aligned if the host has it. Every viewer's scene is a function of it. */
  clock?: () => number;
  render?: RenderSettings;
  /** Keep the drawing buffer (render-showcase reads frames back). */
  preserveDrawingBuffer?: boolean;
  /** Test seams. */
  createRenderer?: (canvas: HTMLCanvasElement, preserveDrawingBuffer: boolean) => SceneRenderer;
  loadTexture?: (url: string) => Promise<THREE.Texture>;
  fetchJson?: (url: string) => Promise<unknown>;
  loopHost?: LoopHost;
}

const MAX_EVENTS = 500;

/**
 * The room view (brief §5 M11): a view-only three.js scene on a canvas, for the desktop `room`
 * window and the web /r/[id]. Feed it members and room-event metadata; it plays the portal
 * teleports, the seeded wander and the walk-over-and-talk, the same on every viewer. It has no
 * input handlers and writes nothing: no viewer can move anyone.
 */
export class RoomScene {
  readonly #opts: RoomSceneOptions;
  readonly #renderer: SceneRenderer;
  readonly #camera = new THREE.PerspectiveCamera(35, 1, 0.1, 30);
  readonly #world: RoomWorld;
  readonly #settings: RenderSettings;
  readonly #clock: () => number;
  #quality: RenderQuality;
  #level: QualityLevel;
  #loop: FrameLoop | null = null;
  #running = false;
  #members: RoomSceneMember[] = [];
  readonly #known = new Map<string, string>();
  readonly #events = new Map<string, SceneEvent>();
  #sorted: SceneEvent[] = [];
  readonly #loading = new Map<string, Promise<void>>();
  readonly #loadedKey = new Map<string, string>();
  readonly #qualityCbs = new Set<(q: QualityLevel) => void>();
  #probe: { start: number; frames: number } | null = null;
  #settled = true;
  #size = { w: 0, h: 0, ratio: 0 };
  #frames = 0;
  #disposed = false;

  constructor(opts: RoomSceneOptions) {
    this.#opts = opts;
    this.#settings = opts.render ?? RENDER_DEFAULTS;
    this.#clock = opts.clock ?? (() => Date.now());
    this.#renderer =
      opts.createRenderer?.(opts.canvas, !!opts.preserveDrawingBuffer) ??
      (new THREE.WebGLRenderer({
        canvas: opts.canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      }) as unknown as SceneRenderer);
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#camera.position.set(0, 1.55, 3.7);
    this.#camera.lookAt(0, 0.45, -0.25);
    this.#quality = opts.quality ?? this.#settings.default;
    this.#level = this.#initialLevel();
    this.#world = new RoomWorld(this.#settings.levels[this.#level]);
    if (this.#settled) queueMicrotask(() => this.#qualityCbs.forEach((cb) => cb(this.#level)));
  }

  /** The level being drawn now (what "auto" resolved to, once probed). */
  get level(): QualityLevel {
    return this.#level;
  }

  get quality(): RenderQuality {
    return this.#quality;
  }

  /** Frames drawn so far (for the FPS check and tests). */
  get frames(): number {
    return this.#frames;
  }

  /** The current members (replaces the list). Cards load in the background. */
  setMembers(members: readonly RoomSceneMember[]): void {
    this.#members = members.map((m) => ({ ...m, cosmetics: m.cosmetics ? [...m.cosmetics] : undefined }));
    for (const m of this.#members) {
      this.#known.set(m.companionId, m.avatar);
      void this.#load(m);
    }
  }

  /** Room-event metadata (idempotent by eid). The scene never sees content. */
  pushEvents(events: readonly SceneEvent[]): void {
    for (const e of events) {
      if (this.#events.has(e.eid)) continue;
      // Copy only the metadata fields: whatever else a caller passes never reaches the scene.
      this.#events.set(e.eid, { eid: e.eid, fromCompanionId: e.fromCompanionId, to: [...e.to], kind: e.kind, t: e.t });
    }
    this.#sorted = [...this.#events.values()].sort((a, b) => a.t - b.t || (a.eid < b.eid ? -1 : 1));
    if (this.#sorted.length > MAX_EVENTS) {
      for (const e of this.#sorted.slice(0, this.#sorted.length - MAX_EVENTS)) this.#events.delete(e.eid);
      this.#sorted = this.#sorted.slice(-MAX_EVENTS);
    }
  }

  setQuality(q: RenderQuality): void {
    this.#quality = q;
    this.#setLevel(this.#initialLevel());
  }

  /** Called with the level "auto" settles on (and on every later change). */
  onQuality(cb: (level: QualityLevel) => void): () => void {
    this.#qualityCbs.add(cb);
    return () => this.#qualityCbs.delete(cb);
  }

  /** Resolves when every current member's card is loaded. */
  async ready(): Promise<void> {
    await Promise.all([...this.#loading.values()]);
  }

  start(): void {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    this.#startLoop();
  }

  stop(): void {
    this.#running = false;
    this.#loop?.stop();
    this.#loop = null;
  }

  /** The scene at time t, drawn now (the loop calls this; render-showcase calls it with fixed times). */
  renderAt(t: number): SceneState {
    const state = choreograph(this.#opts.roomId, this.#members, this.#sorted, t, this.#known);
    this.#world.update(state, t);
    this.#fit();
    this.#renderer.render(this.#world.scene, this.#camera);
    this.#frames++;
    return state;
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    this.#world.dispose();
    this.#renderer.dispose();
    this.#qualityCbs.clear();
  }

  /** Auto starts at alto and probes for probeSeconds (#tick); software GL goes straight to bajo. */
  #initialLevel(): QualityLevel {
    this.#probe = null;
    this.#settled = this.#quality !== "auto";
    if (this.#quality !== "auto") return this.#quality;
    if (isSoftwareRenderer(this.#rendererName())) {
      this.#settled = true;
      return "bajo";
    }
    return "alto";
  }

  #setLevel(level: QualityLevel, notify = false): void {
    const changed = level !== this.#level;
    this.#level = level;
    this.#world?.setLevel(this.#settings.levels[level]);
    this.#size.ratio = 0; // re-apply the pixel ratio cap
    if (this.#running) this.#startLoop();
    if (changed || notify) for (const cb of this.#qualityCbs) cb(level);
  }

  #startLoop(): void {
    this.#loop?.stop();
    const level = this.#settings.levels[this.#level];
    this.#loop = new FrameLoop(() => this.#tick(), level.fpsCap, this.#opts.loopHost ?? browserHost());
    this.#loop.start();
  }

  #tick(): void {
    this.renderAt(this.#clock());
    if (this.#quality !== "auto" || this.#settled) return;
    const now = performance.now();
    if (!this.#probe) {
      this.#probe = { start: now, frames: 0 };
      return;
    }
    this.#probe.frames++;
    const secs = (now - this.#probe.start) / 1000;
    if (secs < this.#settings.auto.probeSeconds) return;
    this.#settled = true;
    this.#setLevel(
      pickQuality({ renderer: this.#rendererName(), fps: this.#probe.frames / secs }, this.#settings),
      true,
    );
    this.#probe = null;
  }

  #rendererName(): string | null {
    try {
      const gl = this.#renderer.getContext() as WebGLRenderingContext;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    } catch {
      return null;
    }
  }

  #fit(): void {
    const c = this.#opts.canvas;
    const w = Math.max(1, c.clientWidth || c.width);
    const h = Math.max(1, c.clientHeight || c.height);
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const ratio = Math.min(dpr, this.#settings.levels[this.#level].pixelRatioMax);
    if (w === this.#size.w && h === this.#size.h && ratio === this.#size.ratio) return;
    this.#size = { w, h, ratio };
    this.#renderer.setPixelRatio(ratio);
    this.#renderer.setSize(w, h, false);
    this.#camera.aspect = w / h;
    // Narrow (phone) canvases pull back so the whole floor fits.
    this.#camera.position.z = w / h < 1 ? 3.7 + (1 - w / h) * 3 : 3.7;
    this.#camera.updateProjectionMatrix();
  }

  #load(m: RoomSceneMember): Promise<void> {
    const key = `${m.avatar}|${(m.cosmetics ?? []).map((c) => c.art).join(",")}`;
    if (this.#loadedKey.get(m.companionId) === key) return this.#loading.get(m.companionId) ?? Promise.resolve();
    this.#loadedKey.set(m.companionId, key);
    const p = loadCardAssets(this.#opts.assetBase, m.avatar, m.cosmetics ?? [], {
      fetchJson: this.#opts.fetchJson,
      loadTexture: this.#opts.loadTexture,
    }).then(
      (assets) => {
        if (!this.#disposed && this.#loadedKey.get(m.companionId) === key) this.#world.addActor(m.companionId, assets);
      },
      () => undefined, // missing art: the companion just isn't drawn
    );
    this.#loading.set(m.companionId, p);
    return p;
  }
}
