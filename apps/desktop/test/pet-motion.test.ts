import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PetContext } from "../src/lib/pet-context.js";
import { DRAG_QUIET_MS, PLACE_RECHECK_MS, PetMotion, type MotionInput, type PetWindowApi } from "../src/pet/motion.js";
import { HOVER_DWELL_MS } from "../src/pet/mouse.js";
import { saveSpot, setupKey, type Screen, type Spot } from "../src/pet/spot.js";
import { WALK } from "../src/pet/walk.js";

const laptop: Screen = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  work: { x: 0, y: 0, width: 1920, height: 1040 },
  scale: 1,
};
const CORNER = { x: 1676, y: 780 };
const ctx: PetContext = { level: null, fullscreen: false, dnd: false, quietHours: false, lowEnergy: false };
const HIT = { x: CORNER.x + 60, y: CORNER.y + 40, width: 100, height: 200 };

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake pet window: moves are recorded and echoed back as move events, like the OS does. */
interface FakeWindow {
  pos: Spot;
  cursor: Spot;
  moves: Spot[];
  drags: number;
  size: { width: number; height: number };
  move(x: number, y: number): void;
  api: PetWindowApi;
}

const fakeWindow = (screens: Screen[] = [laptop], broken: Partial<PetWindowApi> = {}): FakeWindow => {
  let moved: ((p: Spot) => void) | null = null;
  const w: FakeWindow = {
    pos: { ...CORNER },
    cursor: { x: 10, y: 10 },
    moves: [] as { x: number; y: number }[],
    drags: 0,
    size: { width: 220, height: 260 },
    move(x: number, y: number) {
      w.pos = { x, y };
      moved?.({ x, y });
    },
    api: {
      cursor: async () => ({ ...w.cursor }),
      position: async () => ({ ...w.pos }),
      size: async () => ({ ...w.size }),
      screens: async () => screens,
      setPosition: async (x: number, y: number) => {
        w.moves.push({ x, y });
        w.move(x, y);
      },
      startDragging: async () => {
        w.drags++;
      },
      onMoved: async (cb: (p: { x: number; y: number }) => void) => {
        moved = cb;
        return () => (moved = null);
      },
    },
  };
  w.api = { ...w.api, ...broken };
  return w;
};

const setup = (
  o: {
    screens?: Screen[];
    walk?: boolean;
    storage?: ReturnType<typeof memory>;
    broken?: Partial<PetWindowApi>;
    /** What the window manager does while placement waits to re-check. */
    meanwhile?: (w: FakeWindow) => void;
    pos?: Spot;
  } = {},
) => {
  let t = 0;
  const w = fakeWindow(o.screens, o.broken);
  if (o.pos) w.pos = { ...o.pos };
  const storage = o.storage ?? memory();
  const onClick = vi.fn();
  const onMoved = vi.fn();
  const m = new PetMotion(w.api, {
    storage,
    walkEnabled: () => o.walk ?? true,
    onMoved,
    onClick,
    rand: () => 0.5,
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
      o.meanwhile?.(w);
    },
  });
  const input = (over: Partial<MotionInput> = {}): MotionInput => ({ hit: HIT, scale: 1, state: "idle", ctx, ...over });
  const at = (now: number, over: Partial<MotionInput> = {}) => {
    t = now;
    return m.update(now, input(over));
  };
  return { m, w, storage, onClick, onMoved, at, setT: (v: number) => (t = v) };
};

const press = (el: HTMLElement, type: string, x: number, y: number) =>
  el.dispatchEvent(new MouseEvent(type, { button: 0, screenX: x, screenY: y }));

describe("pet motion: saved spot", () => {
  it("moves to the spot saved for this monitor setup at launch", async () => {
    const storage = memory();
    saveSpot(setupKey([laptop]), { x: 300, y: 780 }, storage);
    const { m, w, onMoved } = setup({ storage });
    await m.start();
    expect(w.moves).toEqual([{ x: 300, y: 780 }]);
    expect(onMoved).toHaveBeenCalled();
  });

  it("stays in the corner when nothing is saved or the saved monitor is gone", async () => {
    const s1 = setup();
    await s1.m.start();
    expect(s1.w.moves).toEqual([]);

    const storage = memory();
    saveSpot(setupKey([laptop]), { x: -1500, y: 780 }, storage);
    const s2 = setup({ storage });
    await s2.m.start();
    expect(s2.w.moves).toEqual([]);
  });
});

describe("pet motion: launch placement after the window is shown (GNOME/mutter)", () => {
  // The owner's laptop, 2026-10-25: dock on the left, top bar; mutter opened the pet mid-screen.
  const gnome: Screen = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    work: { x: 67, y: 32, width: 1853, height: 1048 },
    scale: 1,
    primary: true,
  };

  it("an unsaved pet left mid-screen by the WM goes to the corner, using its real mapped size", async () => {
    const s = setup({ screens: [gnome], pos: { x: 1013, y: 709 } });
    s.w.size = { width: 220, height: 297 };
    await s.m.start();
    expect(s.w.pos).toEqual({ x: 1676, y: 783 });
  });

  it("placement is re-applied after show when the WM moves the fresh window, and that move isn't saved", async () => {
    let wmMoves = 1;
    const s = setup({
      screens: [gnome],
      pos: { x: 1013, y: 709 },
      meanwhile: (w) => wmMoves-- > 0 && w.move(1013, 709),
    });
    s.w.size = { width: 220, height: 297 };
    await s.m.start();
    expect(s.w.pos).toEqual({ x: 1676, y: 783 });
    expect(s.w.moves).toEqual([
      { x: 1676, y: 783 },
      { x: 1676, y: 783 },
    ]);
    s.at(DRAG_QUIET_MS + 1);
    await flush();
    expect(s.m.dragging).toBe(false);
    expect(s.storage.getItem("chalito-pet-spot")).toBeNull();
  });

  it("the person grabbing it during launch wins: no re-placement over their drag", async () => {
    const el = document.createElement("div");
    const s = setup({
      screens: [gnome],
      pos: { x: 1013, y: 709 },
      meanwhile: (w) => {
        press(el, "pointerdown", 100, 100);
        press(el, "pointermove", 130, 100);
        w.move(500, 400);
      },
    });
    s.m.attach(el);
    s.w.size = { width: 220, height: 297 };
    await s.m.start();
    expect(s.w.pos).toEqual({ x: 500, y: 400 });
  });
});

describe("pet motion: press, drag and click", () => {
  it("a press without movement is a click: reported once, the scene picks the trick", async () => {
    const { m, at, onClick, w } = setup();
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 102, 101);
    press(el, "pointerup", 102, 101);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(w.drags).toBe(0);
    expect(at(10).play).toBeNull();
  });

  it("moving past the threshold drags the window, no click; letting go saves the spot", async () => {
    const { m, at, onClick, w, storage } = setup();
    await m.start();
    const el = document.createElement("div");
    const detach = m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 110, 100);
    expect(w.drags).toBe(1);
    expect(m.dragging).toBe(true);
    // The OS moves the window while the person drags.
    w.move(900, 500);
    at(100);
    expect(m.dragging).toBe(true);
    w.move(800, 780);
    press(el, "pointerup", 300, 300);
    expect(onClick).not.toHaveBeenCalled();
    at(100 + DRAG_QUIET_MS + 1);
    expect(m.dragging).toBe(false);
    await flush();
    expect(JSON.parse(storage.getItem("chalito-pet-spot")!)).toEqual({ [setupKey([laptop])]: { x: 800, y: 780 } });
    detach();
    press(el, "pointerdown", 0, 0);
    press(el, "pointerup", 0, 0);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a drag that didn't move the window saves nothing", async () => {
    const { m, at, storage } = setup();
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 120, 100);
    at(DRAG_QUIET_MS + 1);
    await flush();
    expect(storage.getItem("chalito-pet-spot")).toBeNull();
  });

  it("every window move refreshes the hit box geometry (click-through follows the window)", async () => {
    const { m, w, onMoved } = setup();
    await m.start();
    onMoved.mockClear();
    w.move(500, 780);
    w.move(510, 780);
    expect(onMoved).toHaveBeenCalledTimes(2);
  });
});

describe("pet motion: cursor and hover", () => {
  it("looks toward the cursor while it moves", async () => {
    const { m, w, at } = setup();
    await m.start();
    w.cursor = { x: 0, y: 0 };
    at(0);
    await flush();
    const g = at(100).gaze;
    expect(g.yaw).toBeLessThan(-5);
    expect(g.pitch).toBeGreaterThan(5);
  });

  it("notices a cursor resting on it, only while calm", async () => {
    const { m, w, at } = setup();
    await m.start();
    w.cursor = { x: HIT.x + 50, y: HIT.y + 50 };
    at(0);
    await flush();
    expect(at(10).play).toBeNull();
    expect(at(10 + HOVER_DWELL_MS).play).toBe("notice");

    const busy = setup();
    await busy.m.start();
    busy.w.cursor = { x: HIT.x + 50, y: HIT.y + 50 };
    busy.at(0, { state: "knock" });
    await flush();
    busy.at(10, { state: "knock" });
    expect(busy.at(10 + HOVER_DWELL_MS, { state: "knock" }).play).toBeNull();
  });

  it("notices the pointer from its own events when the global cursor is stale (XWayland)", async () => {
    const { m, w, at } = setup();
    await m.start();
    w.cursor = { x: 5, y: 5 };
    const el = document.createElement("div");
    m.attach(el);
    at(0);
    await flush();
    el.dispatchEvent(new MouseEvent("pointerenter", { screenX: HIT.x + 10, screenY: HIT.y + 10 }));
    expect(at(10).play).toBeNull();
    expect(at(10 + HOVER_DWELL_MS).play).toBe("notice");
    el.dispatchEvent(new MouseEvent("pointerleave"));
    at(20 + HOVER_DWELL_MS);
    expect(at(30 + 2 * HOVER_DWELL_MS).play).toBeNull();
  });

  it("remembers where it was grabbed, for hanging from that point", async () => {
    const { m } = setup();
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    el.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 110, clientY: 60 }));
    expect(m.grab).toEqual({ x: 110, y: 60 });
  });
});

describe("pet motion: walking", () => {
  it("after the launch cooldown, a calm pet walks along the bottom and stays on screen", async () => {
    const { m, w, at } = setup();
    await m.start();
    expect(at(WALK.firstAfterMs - 1).play).toBeNull();
    expect(at(WALK.firstAfterMs).play).toBe("walk");
    expect(m.walking).toBe(true);
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
    }
    expect(m.walking).toBe(false);
    expect(w.moves.length).toBeGreaterThan(5);
    for (const p of w.moves) {
      expect(p.y).toBe(CORNER.y);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1920 - 220);
    }
  });

  it("stops mid-walk when something needs the person", async () => {
    const { m, w, at } = setup();
    await m.start();
    at(WALK.firstAfterMs);
    at(WALK.firstAfterMs + 200);
    await flush();
    at(WALK.firstAfterMs + 400, { state: "hop" });
    const n = w.moves.length;
    for (let t = WALK.firstAfterMs + 440; t < WALK.firstAfterMs + 3000; t += 40) at(t, { state: "hop" });
    await flush();
    expect(m.walking).toBe(false);
    expect(w.moves.length).toBe(n);
  });

  it("doesn't walk with the setting off, in DND, or when not standing on the taskbar", async () => {
    const off = setup({ walk: false });
    await off.m.start();
    expect(off.at(WALK.firstAfterMs).play).toBeNull();

    const dnd = setup();
    await dnd.m.start();
    expect(dnd.at(WALK.firstAfterMs, { ctx: { ...ctx, dnd: true } }).play).toBeNull();

    const storage = memory();
    saveSpot(setupKey([laptop]), { x: 800, y: 300 }, storage);
    const up = setup({ storage });
    await up.m.start();
    expect(up.at(WALK.firstAfterMs).play).toBeNull();
  });

  it("not soon after the person dragged it", async () => {
    const { m, w, at } = setup();
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 120, 100);
    w.move(600, 780);
    at(WALK.firstAfterMs - 1000);
    at(WALK.firstAfterMs - 1000 + DRAG_QUIET_MS + 1);
    expect(at(WALK.firstAfterMs + 1000).play).toBeNull();
    expect(m.walking).toBe(false);
  });
});

describe("pet motion: drags that pause, outside moves, failures", () => {
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("a drag that pauses past the quiet gap still saves where it was dropped, and home follows", async () => {
    const { m, w, at, storage } = setup();
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 120, 100);
    at(PLACE_RECHECK_MS + DRAG_QUIET_MS + 1); // held still: no move events yet
    expect(m.dragging).toBe(false);
    w.move(200, 780); // the person keeps dragging
    expect(m.dragging).toBe(true);
    at(2000);
    at(2000 + DRAG_QUIET_MS + 1);
    await flush();
    expect(JSON.parse(storage.getItem("chalito-pet-spot")!)).toEqual({ [setupKey([laptop])]: { x: 200, y: 780 } });
    // The next walk starts near where it was dropped, not back at the corner.
    const t0 = 2000 + WALK.afterPersonMs;
    at(t0);
    for (let t = t0; t < t0 + 10_000; t += 40) {
      at(t);
      await flush();
    }
    for (const p of w.moves) expect(Math.abs(p.x - 200)).toBeLessThanOrEqual(WALK.stepMax);
  });

  it("its own walk moves are never taken for the person moving it", async () => {
    const { m, at, storage } = setup();
    await m.start();
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
      expect(m.dragging).toBe(false);
    }
    expect(storage.getItem("chalito-pet-spot")).toBeNull();
  });

  it("re-reads its size after moving to a screen with another scale, so it still walks there", async () => {
    const hidpi: Screen = {
      bounds: { x: 1920, y: 0, width: 2880, height: 1800 },
      work: { x: 1920, y: 0, width: 2880, height: 1740 },
      scale: 1.5,
    };
    const storage = memory();
    saveSpot(setupKey([laptop, hidpi]), { x: 3000, y: 1350 }, storage);
    const s = setup({ screens: [laptop, hidpi], storage });
    const set = s.w.api.setPosition;
    s.w.api.setPosition = async (x, y) => {
      if (x >= 1920) s.w.size = { width: 330, height: 390 };
      await set(x, y);
    };
    await s.m.start();
    expect(s.at(WALK.firstAfterMs).play).toBe("walk");
  });

  it("no move events: walking stays off instead of starting from a stale spot", async () => {
    const warn = quiet();
    const { m, at } = setup({ broken: { onMoved: () => Promise.reject(new Error("denied")) } });
    await m.start();
    expect(at(WALK.firstAfterMs).play).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no monitor info at launch: no throw, it stays put and doesn't walk", async () => {
    const warn = quiet();
    const { m, w, at } = setup({ broken: { screens: () => Promise.reject(new Error("x")) } });
    await m.start();
    expect(w.moves).toEqual([]);
    expect(at(WALK.firstAfterMs).play).toBeNull();
    warn.mockRestore();
  });

  it("a failed walk step stops the walk until the next turn", async () => {
    const warn = quiet();
    const { m, at, w } = setup({ broken: { setPosition: () => Promise.reject(new Error("no capability")) } });
    await m.start();
    at(WALK.firstAfterMs);
    expect(m.walking).toBe(true);
    at(WALK.firstAfterMs + 40); // first step sent, and refused
    await flush();
    await flush();
    at(WALK.firstAfterMs + 80);
    expect(m.walking).toBe(false);
    for (let t = WALK.firstAfterMs + 80; t < WALK.firstAfterMs + WALK.gapMinMs - 1; t += 1000) at(t);
    expect(m.walking).toBe(false);
    expect(w.moves).toEqual([]);
    warn.mockRestore();
  });

  it("a drag the OS refuses ends at once and saves nothing", async () => {
    const warn = quiet();
    const { m, at, storage } = setup({ broken: { startDragging: () => Promise.reject(new Error("x")) } });
    await m.start();
    const el = document.createElement("div");
    m.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 120, 100);
    await flush();
    at(10);
    expect(m.dragging).toBe(false);
    await flush();
    expect(storage.getItem("chalito-pet-spot")).toBeNull();
    warn.mockRestore();
  });
});

describe("pet motion: never over a finish hop or failure slump, nor while asleep", () => {
  it("an AI just finished (its hop is playing) as the walk turn comes due: no walk until it's over", async () => {
    const { m, at } = setup();
    await m.start();
    expect(at(WALK.firstAfterMs, { actionPlaying: true }).play).toBeNull();
    expect(m.walking).toBe(false);
    expect(at(WALK.firstAfterMs + 2500).play).toBe("walk");
  });

  it("no hover notice over a playing finish/failure action", async () => {
    const { m, w, at } = setup();
    await m.start();
    w.cursor = { x: HIT.x + 50, y: HIT.y + 50 };
    at(0);
    await flush();
    at(10, { actionPlaying: true });
    expect(at(10 + HOVER_DWELL_MS, { actionPlaying: true }).play).toBeNull();
  });

  it("asleep (quiet hours) or under a fullscreen app it neither polls nor follows the cursor", async () => {
    const cursor = vi.fn(async () => ({ x: 0, y: 0 }));
    const { m, at } = setup({ broken: { cursor } });
    await m.start();
    expect(at(0, { state: "sleepy" }).gaze).toEqual({ yaw: 0, pitch: 0 });
    at(100, { ctx: { ...ctx, fullscreen: true } });
    expect(cursor).not.toHaveBeenCalled();
    at(200);
    expect(cursor).toHaveBeenCalledTimes(1);
  });
});

describe("pet-move capability", () => {
  const read = (f: string) =>
    JSON.parse(readFileSync(join(__dirname, "../src-tauri/capabilities", f), "utf8")) as {
      windows: string[];
      permissions: unknown[];
    };

  it("lets only the pet window move and start dragging itself", () => {
    const cap = read("pet-move.json");
    expect(cap.windows).toEqual(["pet"]);
    expect(cap.permissions).toEqual(["core:window:allow-set-position", "core:window:allow-start-dragging"]);
    expect(JSON.stringify(read("default.json").permissions)).not.toMatch(/set-position|start-dragging/);
  });
});
