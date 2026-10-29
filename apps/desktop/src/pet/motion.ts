import { ACTION_MS, type BehaviourState, type CreatureAction, type Gaze } from "@chalito/avatar";
import { contains, type Rect } from "../lib/hitbox.js";
import type { PetContext } from "../lib/pet-context.js";
import { PressTracker, Reactions, cursorGaze, eyePoint, followWeight, scaleGaze } from "./mouse.js";
import { launchSpot, loadSpot, saveSpot, screenAt, setupKey, type Screen, type Spot } from "./spot.js";
import { WalkPlanner, mayWalk, onFloor, walkAt, walkMs, xBounds, type WalkGate } from "./walk.js";

/** The pet window as motion needs it; positions and sizes in PHYSICAL px (the client area, as moves place it). */
export interface PetWindowApi {
  cursor(): Promise<Spot>;
  position(): Promise<Spot>;
  size(): Promise<{ width: number; height: number }>;
  screens(): Promise<Screen[]>;
  setPosition(x: number, y: number): Promise<void>;
  startDragging(): Promise<void>;
  onMoved(cb: (p: Spot) => void): Promise<() => void>;
}

export interface MotionInput {
  /** The hit box last sent to Rust (physical screen px), or null while nothing is drawn. */
  hit: Rect | null;
  scale: number;
  state: BehaviourState;
  ctx: PetContext;
  /** A finish hop or failure slump is playing: mouse reactions and walks must not cut it off. */
  actionPlaying?: boolean;
}

export interface MotionOutput {
  gaze: Gaze;
  play: CreatureAction | null;
}

export interface MotionOptions {
  storage: Pick<Storage, "getItem" | "setItem">;
  walkEnabled: () => boolean;
  /** The window moved (drag, walk, restore): refresh the geometry the hit box is built from. */
  onMoved: () => void;
  onClick: () => void;
  rand?: () => number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CURSOR_POLL_MS = 66;
/** No move events for this long after a drag started: the person let go. */
export const DRAG_QUIET_MS = 450;
const WALK_SEND_MS = 33;
const OWN_MOVE_GRACE_MS = 400;
const SCREENS_REFRESH_MS = 30_000;
export const PLACE_RECHECK_MS = 700;
/** A walk that hasn't arrived this long after it should have (a stuck move call) is dropped. */
const WALK_SLACK_MS = 2000;
const WALK_LOOK_YAW = 20;

const calm = (s: BehaviourState) => s === "idle" || s === "tired";

/** Drag to move (saved per monitor setup), eyes on the cursor, hover/poke reactions and short idle
 * walks on the taskbar (owner, 2026-10-25). Driven from the scene's frame loop. */
export class PetMotion {
  readonly #press = new PressTracker();
  readonly #reactions = new Reactions();
  readonly #planner: WalkPlanner;
  readonly #rand: () => number;
  readonly #clock: () => number;
  #pos: Spot | null = null;
  #size: { width: number; height: number } | null = null;
  #screens: Screen[] = [];
  #home: number | null = null;
  #cursor: Spot | null = null;
  #cursorMovedAt = -Infinity;
  #cursorPolledAt = -Infinity;
  #cursorBusy = false;
  #drag: { from: Spot | null; lastMoveAt: number } | null = null;
  #walk: { from: number; to: number; y: number; start: number; sent: number; sentAt: number; cycleAt: number } | null =
    null;
  #moveBusy = false;
  #own: Spot | null = null;
  #ownUntil = -Infinity;
  #movedEvents = false;
  #refreshedAt = -Infinity;
  /** The pointer is over the character (its own events: the global cursor can be stale on XWayland). */
  #inside = false;
  /** Where the last press landed on the canvas (CSS px): the point it hangs from while dragged. */
  #grab: { x: number; y: number } | null = null;
  /** Launch placement running: the WM's own first moves aren't the person's. */
  #placing = false;
  /** The person grabbed or moved it: launch placement backs off. */
  #touched = false;
  readonly #sleep: (ms: number) => Promise<void>;
  #offMoved: (() => void) | null = null;
  #stopped = false;

  constructor(
    readonly api: PetWindowApi,
    readonly opts: MotionOptions,
  ) {
    this.#rand = opts.rand ?? Math.random;
    this.#clock = opts.clock ?? (() => performance.now());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#planner = new WalkPlanner(this.#rand, this.#clock());
  }

  get dragging(): boolean {
    return this.#drag !== null;
  }

  get walking(): boolean {
    return this.#walk !== null;
  }

  /** The window's position (physical px), as last seen. */
  get position(): Spot | null {
    return this.#pos;
  }

  get grab(): { x: number; y: number } | null {
    return this.#grab;
  }

  /** Puts the shown window on its saved spot, else the work area's bottom-right corner, using its real size. */
  async start(): Promise<void> {
    const off = await this.api
      .onMoved((p) => this.#moved(p))
      .catch((e: unknown) => {
        console.warn("pet: no window move events; walking stays off", e);
        return null;
      });
    if (this.#stopped) return off?.();
    this.#offMoved = off;
    this.#movedEvents = off !== null;
    this.#placing = true;
    try {
      await this.#place();
      // Mutter ignores Rust's pre-map placement and may place a fresh window late: check once more.
      await this.#sleep(PLACE_RECHECK_MS);
      if (!this.#stopped && !this.#touched) await this.#place();
    } catch (e) {
      console.warn("pet: launch placement failed; leaving it where the OS put it", e);
    } finally {
      this.#placing = false;
    }
    this.#home = this.#pos?.x ?? null;
  }

  async #place(): Promise<void> {
    const [screens, size, pos] = await Promise.all([this.api.screens(), this.api.size(), this.api.position()]);
    this.#screens = screens;
    this.#size = size;
    this.#pos = pos;
    this.#refreshedAt = this.#clock();
    const spot = launchSpot(loadSpot(setupKey(screens), this.opts.storage), size, screens, pos);
    if (!spot || this.#touched || (spot.x === pos.x && spot.y === pos.y)) return;
    await this.#setPosition(spot.x, spot.y);
    this.#pos = spot;
    this.opts.onMoved();
  }

  stop(): void {
    this.#stopped = true;
    this.#offMoved?.();
    this.#offMoved = null;
  }

  /** Press handling on the canvas (it only gets events over the character: click-through elsewhere). */
  attach(el: HTMLElement): () => void {
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (this.#drag) this.#endDrag(this.#clock());
      this.#press.down(e.screenX, e.screenY);
      this.#grab = { x: e.clientX, y: e.clientY };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events (tests) have no active pointer to capture.
      }
    };
    const move = (e: PointerEvent) => {
      this.#inside = true;
      this.#pointerAt(e);
      if (this.#press.move(e.screenX, e.screenY) === "drag") this.#beginDrag();
    };
    const up = () => {
      if (this.#press.up() !== "click") return;
      // The click is the reaction this hover: no notice right after it to cut the trick short.
      this.#reactions.poke(this.#clock());
      this.opts.onClick();
    };
    const cancel = () => this.#press.cancel();
    const enter = (e: PointerEvent) => {
      this.#inside = true;
      this.#pointerAt(e);
    };
    const leave = () => {
      this.#inside = false;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }

  /** The pointer over the character, from its own events (physical px like the polled cursor). */
  #pointerAt(e: PointerEvent): void {
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const c = { x: Math.round(e.screenX * dpr), y: Math.round(e.screenY * dpr) };
    const prev = this.#cursor;
    if (!prev || Math.abs(c.x - prev.x) >= 2 || Math.abs(c.y - prev.y) >= 2) this.#cursorMovedAt = this.#clock();
    this.#cursor = c;
  }

  update(now: number, i: MotionInput): MotionOutput {
    // Asleep or under a fullscreen app it doesn't watch the mouse (nor poll it).
    const watching = i.state !== "sleepy" && !i.ctx.fullscreen;
    if (watching) this.#pollCursor(now);
    if (this.#drag && now - this.#drag.lastMoveAt > DRAG_QUIET_MS) this.#endDrag(now);
    if (!this.#walk && !this.#drag && now - this.#refreshedAt > SCREENS_REFRESH_MS) void this.#refreshScreens(now);
    const hovering =
      !this.#drag && (this.#inside || (!!this.#cursor && contains(i.hit, this.#cursor.x, this.#cursor.y)));

    let play: CreatureAction | null = null;
    if (this.#reactions.hover(hovering, now, calm(i.state) && !this.#walk && !i.actionPlaying)) play = "notice";

    const walkPlay = this.#stepWalk(now, i, hovering);
    play ??= walkPlay;

    let gaze: Gaze = { yaw: 0, pitch: 0 };
    if (this.#walk) gaze = { yaw: Math.sign(this.#walk.to - this.#walk.from) * WALK_LOOK_YAW, pitch: 0 };
    else if (watching && this.#cursor && i.hit)
      gaze = scaleGaze(cursorGaze(this.#cursor, eyePoint(i.hit), i.scale), followWeight(now - this.#cursorMovedAt));
    return { gaze, play };
  }

  #pollCursor(now: number): void {
    if (this.#cursorBusy || now - this.#cursorPolledAt < CURSOR_POLL_MS) return;
    this.#cursorBusy = true;
    this.#cursorPolledAt = now;
    this.api.cursor().then(
      (c) => {
        this.#cursorBusy = false;
        const prev = this.#cursor;
        if (!prev || Math.abs(c.x - prev.x) >= 2 || Math.abs(c.y - prev.y) >= 2) this.#cursorMovedAt = this.#clock();
        this.#cursor = c;
      },
      () => {
        this.#cursorBusy = false;
      },
    );
  }

  #moved(p: Spot): void {
    const now = this.#clock();
    const prev = this.#pos;
    this.#pos = p;
    const own = this.#walk !== null || now < this.#ownUntil || (this.#own?.x === p.x && this.#own?.y === p.y);
    // A move we didn't make is the person (a drag that paused past the quiet gap, or the WM): it counts.
    if (!own && !this.#placing) this.#drag ??= { from: prev, lastMoveAt: now };
    if (this.#drag) this.#touched = true;
    if (this.#drag) this.#drag.lastMoveAt = now;
    this.opts.onMoved();
  }

  /** Moves the window ourselves; the echoed move event isn't taken for the person dragging it. */
  async #setPosition(x: number, y: number): Promise<void> {
    this.#own = { x, y };
    this.#ownUntil = this.#clock() + OWN_MOVE_GRACE_MS;
    await this.api.setPosition(x, y);
    if (!this.#movedEvents) {
      this.#pos = { x, y };
      this.opts.onMoved();
    }
  }

  #beginDrag(): void {
    this.#walk = null;
    this.#drag = { from: this.#pos, lastMoveAt: this.#clock() };
    this.#touched = true;
    void this.api.startDragging().catch((e: unknown) => {
      console.warn("pet: drag failed", e);
      if (this.#drag) this.#drag.lastMoveAt = -Infinity;
    });
  }

  #endDrag(now: number): void {
    const from = this.#drag?.from ?? null;
    this.#drag = null;
    const pos = this.#pos;
    if (!pos || (from && from.x === pos.x && from.y === pos.y)) return;
    this.#planner.personMoved(now);
    this.#home = pos.x;
    void this.#refreshScreens(now).then(() => {
      if (this.#screens.length) saveSpot(setupKey(this.#screens), pos, this.opts.storage);
    });
  }

  /** Screens and the window's size change (monitor plugged, other scale): re-read now and then. */
  async #refreshScreens(now: number): Promise<void> {
    this.#refreshedAt = now;
    try {
      const [screens, size] = await Promise.all([this.api.screens(), this.api.size()]);
      this.#screens = screens;
      this.#size = size;
    } catch (e) {
      console.warn("pet: monitor info unavailable", e);
    }
  }

  /** Advances or starts a walk; returns "walk" at each step cycle. */
  #stepWalk(now: number, i: MotionInput, hovering: boolean): CreatureAction | null {
    const pos = this.#pos;
    const size = this.#size;
    const screen = pos && size ? screenAt(this.#screens, pos.x + size.width / 2, pos.y + size.height / 2) : null;
    if (!pos || !size || !screen) {
      this.#walk = null;
      return null;
    }
    const gate: WalkGate = {
      // Without move events a drag can't be followed, so a walk would start from a stale spot.
      enabled: this.#movedEvents && this.opts.walkEnabled(),
      state: i.state,
      activity: i.ctx.activity?.mode ?? null,
      fullscreen: i.ctx.fullscreen,
      dnd: i.ctx.dnd,
      quietHours: i.ctx.quietHours,
      dragging: this.#drag !== null,
      hovering,
      acting: i.actionPlaying === true,
      onFloor: this.#walk !== null || onFloor({ ...pos, ...size }, screen.work, 6 * screen.scale),
    };
    if (!this.#walk) {
      const target = this.#planner.plan(
        now,
        gate,
        pos.x,
        this.#home ?? pos.x,
        xBounds(screen.work, size.width),
        screen.scale,
      );
      if (target === null) return null;
      this.#walk = {
        from: pos.x,
        to: target,
        y: pos.y,
        start: now,
        sent: pos.x,
        sentAt: -Infinity,
        cycleAt: -Infinity,
      };
    }
    const w = this.#walk;
    if (!mayWalk(gate)) {
      this.#walk = null;
      return null;
    }
    const at = walkAt(w.from, w.to, now - w.start, screen.scale);
    if (now - w.start > walkMs(w.from, w.to, screen.scale) + WALK_SLACK_MS) {
      this.#walk = null;
      return null;
    }
    if (at.x !== w.sent && !this.#moveBusy && now - w.sentAt >= WALK_SEND_MS) {
      w.sent = at.x;
      w.sentAt = now;
      this.#moveBusy = true;
      void this.#setPosition(at.x, w.y)
        .catch((e: unknown) => {
          console.warn("pet: walk step failed", e);
          if (this.#walk === w) this.#walk = null;
        })
        .finally(() => (this.#moveBusy = false));
    }
    if (at.done && w.sent === w.to) {
      this.#walk = null;
      return null;
    }
    if (now - w.cycleAt < ACTION_MS.walk) return null;
    w.cycleAt = now;
    return "walk";
  }
}
