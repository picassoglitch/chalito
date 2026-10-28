import * as THREE from "three";
import { BehaviourMachine, type Activity, type BehaviourOutput } from "@chalito/avatar";
import { AvatarDriver, CreatureBinding, FrameLoop, RetroStepper, createPlaceholder } from "@chalito/avatar-three";
import type { EmotionTag } from "@chalito/protocol";
import { RENDER_DEFAULTS, loadCardAssets, type QualityLevel, type SceneCosmetic } from "@chalito/scene";
import { changedEnough, ndcToCanvas, toScreenHitBox, type Rect } from "../lib/hitbox.js";
import type { PetContext } from "../lib/pet-context.js";
import type { DesktopShell } from "../lib/shell.js";
import { loadSettings } from "../lib/settings-local.js";
import { PET_COSMETICS_REFRESH_MS, cosmeticsKey, watchCosmetics } from "./cosmetics.js";
import type { CustomCardSource } from "@chalito/scene/custom-card";
import { PetLook, QualityResolver } from "./look.js";
import { CARD_WAIT_MS, loadLastDrawn, petCard, saveLastDrawn } from "./choice.js";
import { PerkGate, mouseMayPlay, petReaction, playReaction } from "./reactions.js";
import { PetMotion, type PetWindowApi } from "./motion.js";
import { ClickTracker, pickTrick } from "./clicks.js";
import { Pendulum } from "./hang.js";
import { IDLE_POLL_MS, restFromIdle, wokeUp, type Rest } from "./sleep.js";
import { loadPetWalk } from "../lib/pet-prefs.js";

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

/** The pet window: card (or custom card, see choice.ts), cosmetics, behaviour machine and click-through
 * hit box. render.yaml levels apply as in the room view (bajo = flat impostor, medio/alto = driver). */
export const startPet = (
  canvas: HTMLCanvasElement,
  sh: DesktopShell,
  cosmetics: () => Promise<SceneCosmetic[] | null> = async () => null,
  myCard: Pick<CustomCardSource, "subscribe" | "getSnapshot" | "files" | "refresh"> | null = null,
  win: PetWindowApi | null = null,
) => {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // Eye level, feet near the window's bottom edge: placed on the taskbar it stands on the desktop.
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 0.62, 2.6);
  camera.lookAt(0, 0.62, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 2);
  scene.add(sun);

  const placeholder = createPlaceholder();
  scene.add(placeholder);
  /** What the hit box follows: the placeholder, then the card. */
  let pet: THREE.Object3D = placeholder;
  const driver = new AvatarDriver({ seed: 1 });
  // Retro motion at every level (owner, 2026-10-25): poses step at 10 fps under any FPS cap.
  const retro = new RetroStepper();
  const perks = new PerkGate();
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
  /** A short-lived face for an action (happy after a finish, sad after a failure), then back. */
  let faceUntil = 0;
  const flash = (tag: EmotionTag, now: number, ms: number) => {
    emotion(tag, 0.9, now);
    faceUntil = now + ms;
  };
  /** Says hello once, when its card first shows. */
  let greeted = false;

  /** What this device drew last time: a returning pet shows its roster avatar without waiting. */
  let last = loadLastDrawn();
  let cardWaitOver = false;
  const cardWait = setTimeout(() => {
    cardWaitOver = true;
    applySettings();
  }, CARD_WAIT_MS);

  /** The slider and the companion come from the local settings the panel writes (any window). */
  const applySettings = () => {
    const s = loadSettings();
    applyLevel(quality.set(s.renderQuality));
    const choice = petCard({
      avatar: s.avatar,
      card: !myCard ? null : myCard.getSnapshot() === undefined ? undefined : myCard.files(),
      gaveUp: cardWaitOver,
      last,
    });
    if (choice.kind === "wait") return;
    const custom = choice.kind === "custom" ? choice.files : null;
    const want = `${custom?.key ?? s.avatar}|${cosmeticsKey(wearing)}`;
    if (want === shown) return;
    shown = want;
    const roster = () => loadCardAssets(ROSTER_BASE, s.avatar, wearing);
    (custom ? loadCardAssets(ROSTER_BASE, custom, wearing).catch(roster) : roster()).then(
      (assets) => {
        if (want !== shown) return;
        last = custom ? { kind: "custom" } : { kind: "roster", avatar: s.avatar };
        saveLastDrawn(last);
        const next = new PetLook(assets, levelOf(quality.level));
        next.setEmotion(mood);
        if (look) {
          scene.remove(look.root);
          look.dispose();
        } else scene.remove(placeholder);
        look = next;
        scene.add(next.root);
        pet = next.root;
        if (!greeted) {
          greeted = true;
          driver.playGesture("wave", performance.now());
        }
      },
      () => undefined, // no art: keep what's drawn
    );
  };
  let walkOn = loadPetWalk();
  const onStorage = () => {
    walkOn = loadPetWalk();
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
  let lastActivity: Activity | null = null;
  let sentBox: Rect | null = null;
  let geometry = { innerX: 0, innerY: 0, scale: 1 };
  let geometryAsk = 0;
  // Moves fire many reads during a drag: only the latest answer may set the hit box's origin.
  const refreshGeometry = () => {
    const n = ++geometryAsk;
    void sh.geometry().then(
      (g) => n === geometryAsk && (geometry = g),
      () => undefined,
    );
  };
  const ack = () => {
    acked = true;
    void sh.sendPetAck();
  };
  const clicks = new ClickTracker();
  let lastTrick: ReturnType<typeof pickTrick> | null = null;
  /** Away or drowsy from the computer's idle time (sleep.ts); a click or any input wakes it. */
  let rest: Rest = "awake";
  /** Bumped by a waking click, so an idle reply already in flight can't put it back to sleep. */
  let wakeSeq = 0;
  const calling = () => !!out && (out.state === "wave" || out.state === "hop" || out.state === "knock");
  const pollIdle = () => {
    const seq = wakeSeq;
    void sh.idleMs().then(
      (ms) => {
        if (seq !== wakeSeq) return;
        const next = restFromIdle(ms);
        // Coming back perks it up, but like other attention moves not in DND/quiet hours or over a call.
        if (wokeUp(rest, next) && !ctx.dnd && !ctx.quietHours && !calling()) {
          const now = performance.now();
          flash("surprised", now, 1500);
          driver.playAction("perk", now);
        }
        rest = next;
      },
      () => undefined,
    );
  };
  const idleTimer = setInterval(pollIdle, IDLE_POLL_MS);
  pollIdle();
  /** One click a trick, a burst dizzy, a double click the dashboard (clicks.ts). While it calls for the
   * person (an answer or approval waits) a click still opens the dashboard at once. */
  const onClick = () => {
    const now = performance.now();
    if (calling()) return ack();
    const r = clicks.click(now);
    if (rest !== "awake") {
      // The waking click still counts toward a double click, so a double click on a sleeping pet opens the dashboard.
      rest = "awake";
      wakeSeq++;
      void sh.touchActivity().catch(() => undefined);
      flash("surprised", now, 1500);
      driver.playAction("perk", now);
      return;
    }
    if (r === "dizzy") {
      flash("surprised", now, 2000);
      driver.playAction("dizzy", now);
    } else if (r === "trick") {
      lastTrick = pickTrick(lastTrick, Math.random);
      flash("happy", now, 1500);
      driver.playAction(lastTrick, now);
    }
  };
  const motion = win
    ? new PetMotion(win, {
        storage: localStorage,
        walkEnabled: () => walkOn,
        onMoved: refreshGeometry,
        onClick,
      })
    : null;
  const pendulum = new Pendulum();
  /** The grab point in the card's space while it hangs from the mouse, null when it stands. */
  let pivot: { x: number; y: number } | null = null;
  let hung = false;
  let lastFrame: number | null = null;
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const grabPoint = (g: { x: number; y: number }) => {
    const ndc = new THREE.Vector2((g.x / window.innerWidth) * 2 - 1, -(g.y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, p) ? { x: p.x, y: p.y } : null;
  };

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    camera.updateProjectionMatrix();
    refreshGeometry();
  };
  resize();
  window.addEventListener("resize", resize);

  let loop: FrameLoop | null = null;
  const tick = (now: number) => {
    if (clicks.due(now)) ack();
    const o = machine.update({ ...ctx, acked, away: rest === "away" }, now);
    acked = false;
    const act = ctx.activity ?? null;
    if (o.state !== out?.state) {
      driver.setSleepy(o.state === "sleepy");
      if (o.gesture === "wave" || o.gesture === "yawn") driver.playGesture(o.gesture, now);
      // An escalation calls once with a hop; it doesn't keep jumping (owner decision 2026-10-19).
      if (o.state === "hop" || o.state === "knock") driver.playAction("hop", now);
      if (o.state === "knock" || o.state === "hop") emotion("excited", o.state === "knock" ? 1 : 0.7, now);
      else if (o.state === "glance") emotion("surprised", 0.4, now);
      else if (o.state === "sleepy") emotion("tired", 1, now);
      else if (now >= faceUntil) emotion(rest === "drowsy" ? "tired" : "neutral", rest === "drowsy" ? 0.6 : 1, now);
    }
    // Busy while an AI works, leaning in while something waits for the person.
    const waiting = o.state === "hop" || o.state === "knock" || o.state === "wave";
    driver.setMode(waiting || act?.mode === "needs_you" ? "needs_you" : act?.mode === "working" ? "working" : "rest");
    if (act) {
      const quiet = ctx.dnd || ctx.quietHours;
      const r = petReaction({
        before: lastActivity,
        now: act,
        behaviour: o.state,
        quiet,
        playing: driver.actionAt(now),
        perkOk: lastActivity && act.messages > lastActivity.messages ? perks.reply(now, !!ctx.panelFocused) : true,
      });
      if (r) playReaction(r, now, flash, driver);
      if (r?.action === "perk") perks.perked(now);
      lastActivity = act;
    }
    if (faceUntil && now >= faceUntil) {
      faceUntil = 0;
      emotion(o.state === "sleepy" || rest === "drowsy" ? "tired" : "neutral", 1, now);
    }
    if (o.requestFocus && !out?.requestFocus) void sh.focusPet("L4").catch(() => undefined);
    out = o;
    if (motion) {
      const playing = driver.actionAt(now);
      const quiet = ctx.dnd || ctx.quietHours;
      // A situation's move (hop, slump, go…) is playing: no walk starts and mouse moves wait (reactions.ts).
      const actionPlaying = !mouseMayPlay("walk", { playing, behaviour: o.state, quiet: false });
      const m = motion.update(now, { hit: sentBox, scale: geometry.scale, state: o.state, ctx, actionPlaying });
      driver.lookAt(m.gaze);
      if (m.play && mouseMayPlay(m.play, { playing, behaviour: o.state, quiet })) driver.playAction(m.play, now);
    }
    const frame = retro.step(now, driver.frame(now));
    // Held by the mouse it hangs from the grab point and swings with the drag (hang.ts); let go, it lands.
    const dt = lastFrame === null ? 0 : (now - lastFrame) / 1000;
    lastFrame = now;
    const dragging = motion?.dragging ?? false;
    if (dragging && !hung) {
      hung = true;
      pendulum.reset();
      const g = motion?.grab;
      pivot = g ? grabPoint(g) : null;
      flash("surprised", now, 60_000);
      rest = "awake";
    } else if (!dragging && hung) {
      hung = false;
      faceUntil = now;
      driver.playAction("hop", now);
    }
    const pos = motion?.position;
    if (pivot && pos) pendulum.step(pos.x / Math.max(geometry.scale, 0.01), dt);
    if (!hung && pivot && pendulum.settled) pivot = null;
    const hang = pivot ? { angle: pendulum.angle, pivot, holding: hung } : null;
    if (look) look.apply(frame, now, hang);
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

  // Presses only arrive over the avatar (click-through elsewhere).
  const detachPress = motion
    ? motion.attach(canvas)
    : (canvas.addEventListener("click", onClick), () => canvas.removeEventListener("click", onClick));
  void motion?.start();
  const offCtx = sh.onPetContext((c) => (ctx = c));

  return () => {
    loop?.stop();
    motion?.stop();
    clearInterval(idleTimer);
    detachPress();
    clearTimeout(cardWait);
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
