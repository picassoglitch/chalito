import * as THREE from "three";
import { BehaviourMachine, type BehaviourOutput } from "@chalito/avatar";
import { AvatarDriver, CreatureBinding, FrameLoop, createPlaceholder } from "@chalito/avatar-three";
import { changedEnough, ndcToCanvas, toScreenHitBox, type Rect } from "../lib/hitbox.js";
import type { PetContext } from "../lib/pet-context.js";
import type { DesktopShell } from "../lib/shell.js";

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
 * The pet: a transparent three.js canvas with the placeholder creature (VRM roster art comes
 * in M8), the behaviour machine (focus only at L4) and the hit box for click-through.
 */
export const startPet = (canvas: HTMLCanvasElement, sh: DesktopShell) => {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 0.6, 3.2);
  camera.lookAt(0, 0.45, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 2);
  scene.add(sun);

  const pet = createPlaceholder();
  scene.add(pet);
  const driver = new AvatarDriver({ seed: 1 });
  const creature = new CreatureBinding(pet);
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

  const loop = new FrameLoop((now) => {
    const o = machine.update({ ...ctx, acked }, now);
    acked = false;
    if (o.state !== out?.state) {
      driver.setSleepy(o.state === "sleepy");
      if (o.gesture === "wave" || o.gesture === "yawn") driver.playGesture(o.gesture, now);
      if (o.state === "knock" || o.state === "hop")
        driver.setEmotion({ tag: "excited", intensity: o.state === "knock" ? 1 : 0.7 }, now);
      else if (o.state === "glance") driver.setEmotion({ tag: "surprised", intensity: 0.4 }, now);
      else driver.setEmotion({ tag: "neutral", intensity: 1 }, now);
    }
    if (o.requestFocus && !out?.requestFocus) void sh.focusPet("L4").catch(() => undefined);
    out = o;
    creature.apply(driver.frame(now));
    renderer.render(scene, camera);

    const hit = toScreenHitBox(
      ndcToCanvas(projectBounds(pet, camera), { width: window.innerWidth, height: window.innerHeight }),
      geometry,
    );
    if (changedEnough(sentBox, hit)) {
      sentBox = hit;
      void sh.setHitBox(hit).catch(() => undefined);
    }
  }, 30);
  loop.start();

  // Clicks only arrive over the avatar (click-through elsewhere): acknowledge and open the panel.
  canvas.addEventListener("click", () => {
    acked = true;
    void sh.sendPetAck();
  });
  const offCtx = sh.onPetContext((c) => (ctx = c));

  return () => {
    loop.stop();
    window.removeEventListener("resize", resize);
    void offCtx.then((f) => f());
    void sh.setHitBox(null);
    renderer.dispose();
  };
};
