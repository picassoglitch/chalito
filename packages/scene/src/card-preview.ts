import * as THREE from "three";
import {
  FrameLoop,
  browserHost,
  createCardAvatar,
  type CardAvatar,
  type LoopHost,
  type SkinId,
} from "@chalito/avatar-three";
import { loadCardAssets, type CardLoaders } from "./card-assets.js";

export interface CardPreviewOptions extends CardLoaders {
  canvas: HTMLCanvasElement;
  /** URL prefix where @chalito/roster's assets/ are served, e.g. "/roster/". */
  assetBase: string;
  avatar: string;
  /** Which drawing to show (card.json emotions key). */
  drawing?: string;
  fps?: number;
  /** Test seams. */
  createRenderer?: (canvas: HTMLCanvasElement) => Pick<
    THREE.WebGLRenderer,
    "setPixelRatio" | "setSize" | "render" | "dispose" | "setClearColor"
  > & {
    outputColorSpace: string;
  };
  loopHost?: LoopHost;
}

/**
 * One roster card, flat and filling its canvas, drawn by the real card renderer: what the store
 * uses to preview a skin (the same shader the room and the desktop pet draw). Only the body is
 * drawn (the store lays drawn items over it as images). The canvas should have the card's aspect.
 */
export class CardPreview {
  readonly #opts: CardPreviewOptions;
  readonly #renderer: ReturnType<NonNullable<CardPreviewOptions["createRenderer"]>>;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-0.5, 0.5, 1, 0, -10, 10);
  #card: CardAvatar | null = null;
  #skin: SkinId | null = null;
  #loop: FrameLoop | null = null;
  #disposed = false;

  constructor(opts: CardPreviewOptions) {
    this.#opts = opts;
    this.#renderer =
      opts.createRenderer?.(opts.canvas) ??
      new THREE.WebGLRenderer({ canvas: opts.canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  /** Loads the card; resolves once it is drawn. */
  async load(): Promise<void> {
    const o = this.#opts;
    const assets = await loadCardAssets(o.assetBase, o.avatar, [], {
      fetchJson: o.fetchJson,
      loadTexture: o.loadTexture,
    });
    if (this.#disposed) return;
    const card = createCardAvatar({ width: assets.spec.width, height: assets.spec.height }, assets.drawings, [], 1);
    if (o.drawing) card.setDrawing(o.drawing);
    card.setSkin(this.#skin);
    this.#card = card;
    this.#scene.add(card.root);
    const half = assets.spec.width / assets.spec.height / 2;
    this.#camera.left = -half;
    this.#camera.right = half;
    this.#camera.updateProjectionMatrix();
    this.#fit();
    this.#draw(0);
    this.#sync();
  }

  get skin(): SkinId | null {
    return this.#skin;
  }

  setSkin(skin: SkinId | null): void {
    this.#skin = skin;
    this.#card?.setSkin(skin);
    this.#sync();
    this.#draw(performance.now());
  }

  dispose(): void {
    this.#disposed = true;
    this.#loop?.stop();
    this.#loop = null;
    this.#card?.dispose();
    this.#renderer.dispose();
  }

  /** Animates only while a skin is on (a plain card is drawn once). */
  #sync(): void {
    const animate = !!this.#card && this.#card.skin !== null && !this.#disposed;
    if (animate && !this.#loop) {
      this.#loop = new FrameLoop((now) => this.#draw(now), this.#opts.fps ?? 30, this.#opts.loopHost ?? browserHost());
      this.#loop.start();
    } else if (!animate && this.#loop) {
      this.#loop.stop();
      this.#loop = null;
    }
  }

  #fit(): void {
    const c = this.#opts.canvas;
    const w = Math.max(1, c.clientWidth || c.width);
    const h = Math.max(1, c.clientHeight || c.height);
    this.#renderer.setPixelRatio(Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2));
    this.#renderer.setSize(w, h, false);
  }

  #draw(now: number): void {
    if (!this.#card || this.#disposed) return;
    this.#card.tick(now / 1000);
    this.#renderer.render(this.#scene, this.#camera);
  }
}
