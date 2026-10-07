import * as THREE from "three";
import { BehaviourMachine, type BehaviourOutput } from "@chalito/avatar";
import { AvatarDriver, CreatureBinding, FrameLoop, createPlaceholder } from "@chalito/avatar-three";
import type { EmotionTag } from "@chalito/protocol";
import { RENDER_DEFAULTS, loadCardAssets, type QualityLevel, type SceneCosmetic } from "@chalito/scene";
import { changedEnough, ndcToCanvas, toScreenHitBox, type Rect } from "../lib/hitbox.js";
import type { PetContext } from "../lib/pet-context.js";
import type { DesktopShell } from "../lib/shell.js";
import { loadSettings } from "../lib/settings-local.js";
import { PET_COSMETICS_REFRESH_MS, cosmeticsKey, watchCosmetics } from "./cosmetics.js";
import type { CustomCardSource } from "@chalito/scene/custom-card";
import { PetLook, QualityResolver } from "./look.js";

/** Where the desktop serves @chalito/roster's assets/ and cosmetics/ (ec83c65). */
const ROSTER_BASE = "/roster/";

const box = new THREE.Box3();
const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

/** The object's world bounds projected to NDC (min/max over the 8 box corners). */
const projectBounds = (obj: THREE.Object3D, camera: THREE.Camera) => {
  box.setFromObject(obj);
  const { min, max } = box;
  let i = 0;
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners[i++]!.set(x, y, z).project(camera);
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
};

/**
 * The pet: a transparent three.js canvas with the companion's roster card (the placeholder until
 * it loads), the behaviour machine (focus only at L4) and the hit box for click-through. The
 * render-quality slider (render.yaml) applies here as in the room view: bajo is the flat card
 * impostor at 30 FPS without contact shadow; medio and alto run the driver's bob, squash and
 * gestures; auto settles from the renderer and a short probe. The equipped cosmetics (from
 * `cosmetics`, once the panel is signed in) are placed on the card as in a room. When the companion
 * wears the person's own custom character (`myCard`), that card is drawn instead of the roster one
 * (its anchors place the cosmetics); if it won't load, the roster card is.
 */
export const startPet = (
  canvas: HTMLCanvasElement,
  sh: DesktopShell,
  cosmetics: () => Promise<SceneCosmetic[] | null> = async () => null,
  myCard: Pick<CustomCardSource, "subscribe" | "files" | "refresh"> | null = null,
) => {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 0.6, 3.2);
  camera.lookAt(0, 0.45, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 2);
  scene.add(sun);

  const placeholder = createPlaceholder();
  scene.add(placeholder);
  /** What the hit box follows: the placeholder, then the card. */
  let pet: THREE.Object3D = placeholder;
  const driver = new AvatarDriver({ seed: 1 });
  const creature = new CreatureBinding(placeholder);
  let look: PetLook | null = null;
  /** What's drawn (or loading): companion card and its cosmetics. */
  let shown: string | null = null;
  let wearing: SceneCosmetic[] = [];
  const rendererName = () => {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  };
  const quality = new QualityResolver(rendererName);
  const levelOf = (l: QualityLevel) => RENDER_DEFAULTS.levels[l];
  const applyLevel = (l: QualityLevel) => {
    const lv = levelOf(l);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, lv.pixelRatioMax));
    look?.setLevel(lv);
    if (loop && loop.fps !== lv.fpsCap) {
      loop.stop();
      loop = new FrameLoop(tick, lv.fpsCap);
      loop.start();
    }
  };
  let mood: EmotionTag = "neutral";
  const emotion = (tag: EmotionTag, intensity: number, now: number) => {
    mood = tag;
    driver.setEmotion({ tag, intensity }, now);
    look?.setEmotion(tag);
  };

  /** The slider and the companion come from the local settings the panel writes (any window). */
  const applySettings = () => {
    const s = loadSettings();
    applyLevel(quality.set(s.renderQuality));
    const custom = myCard?.files() ?? null;
    const want = `${custom?.key ?? s.avatar}|${cosmeticsKey(wearing)}`;
    if (want === shown) return;
    shown = want;
    const roster = () => loadCardAssets(ROSTER_BASE, s.avatar, wearing);
    (custom ? loadCardAssets(ROSTER_BASE, custom, wearing).catch(roster) : roster()).then(
      (assets) => {
        if (want !== shown) return;
        const next = new PetLook(assets, levelOf(quality.level));
        next.setEmotion(mood);
        if (look) {
          scene.remove(look.root);
          look.dispose();
        } else scene.remove(placeholder);
        look = next;
        scene.add(next.root);
        pet = next.root;
      },
      () => undefined, // no art: keep what's drawn
    );
  };
  const onStorage = () => {
    applySettings();
    void wear.refresh();
    // The panel changed something (maybe the companion): ask whether it wears a custom card.
    void myCard?.refresh();
  };
  const offCard = myCard?.subscribe(applySettings);
  // A custom card made or dropped elsewhere (the PWA) shows up within this; its URLs refresh themselves.
  const cardTimer = myCard ? setInterval(() => void myCard.refresh(), PET_COSMETICS_REFRESH_MS) : null;
  const wear = watchCosmetics(cosmetics, (c) => {
    wearing = c;
    applySettings();
  });
  const machine = new BehaviourMachine();
  let ctx: PetContext = { level: null, fullscreen: false, dnd: false, quietHours: false, lowEnergy: false };
  let acked = false;
  let out: BehaviourOutput | null = null;
  let sentBox: Rect | null = null;
  let geometry = { innerX: 0, innerY: 0, scale: 1 };

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    camera.updateProjectionMatrix();
    void sh.geometry().then((g) => (geometry = g));
  };
  resize();
  window.addEventListener("resize", resize);

  let loop: FrameLoop | null = null;
  const tick = (now: number) => {
    const o = machine.update({ ...ctx, acked }, now);
    acked = false;
    if (o.state !== out?.state) {
      driver.setSleepy(o.state === "sleepy");
      if (o.gesture === "wave" || o.gesture === "yawn") driver.playGesture(o.gesture, now);
      if (o.state === "knock" || o.state === "hop") emotion("excited", o.state === "knock" ? 1 : 0.7, now);
      else if (o.state === "glance") emotion("surprised", 0.4, now);
      else if (o.state === "sleepy") emotion("tired", 1, now);
      else emotion("neutral", 1, now);
    }
    if (o.requestFocus && !out?.requestFocus) void sh.focusPet("L4").catch(() => undefined);
    out = o;
    const frame = driver.frame(now);
    if (look) look.apply(frame, now);
    else creature.apply(frame);
    renderer.render(scene, camera);
    const settled = quality.frame(now);
    if (settled) applyLevel(settled);

    const hit = toScreenHitBox(
      ndcToCanvas(projectBounds(pet, camera), { width: window.innerWidth, height: window.innerHeight }),
      geometry,
    );
    if (changedEnough(sentBox, hit)) {
      sentBox = hit;
      void sh.setHitBox(hit).catch(() => undefined);
    }
  };
  loop = new FrameLoop(tick, levelOf(quality.level).fpsCap);
  loop.start();
  applySettings();
  window.addEventListener("storage", onStorage);

  // Clicks only arrive over the avatar (click-through elsewhere): acknowledge and open the panel.
  canvas.addEventListener("click", () => {
    acked = true;
    void sh.sendPetAck();
  });
  const offCtx = sh.onPetContext((c) => (ctx = c));

  return () => {
    loop?.stop();
    wear.stop();
    offCard?.();
    if (cardTimer) clearInterval(cardTimer);
    window.removeEventListener("resize", resize);
    window.removeEventListener("storage", onStorage);
    look?.dispose();
    void offCtx.then((f) => f());
    void sh.setHitBox(null);
    renderer.dispose();
  };
};
