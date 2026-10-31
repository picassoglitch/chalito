import type * as TauriWindow from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The owner's X11 desktop (2026-10-28): 1920×1080, _NET_WORKAREA 67,32,1853,1048, and a pet window
// whose outer frame (297 px) is 37 px taller than its 260 px client, all of it above the client.
const WORK = { x: 67, y: 32, width: 1853, height: 1048 };
const CLIENT = { width: 220, height: 260 };
let FRAME_TOP = 37;
const CORNER = { x: WORK.x + WORK.width - CLIENT.width - 24, y: WORK.y + WORK.height - CLIENT.height };

/** The WM as tao reports it there: setPosition places the client, move events carry the frame's corner. */
const wm = {
  client: { x: 900, y: 400 },
  moved: null as ((p: { x: number; y: number }) => void) | null,
  failReads: false,
  /** ICCCM's rule instead of the owner's WM: a move puts the frame's corner where asked. */
  placesFrame: false,
  /** Where the WM moves the window right after our first setPosition (a late placement). */
  lateTo: null as { x: number; y: number } | null,
  scale: 1,
  /** When set, position reads wait here until the test releases them (in any order). */
  held: null as (() => void)[] | null,
};
const frameOf = (c: { x: number; y: number }) => ({ x: c.x, y: c.y - FRAME_TOP });
/** The person dragging the window, or our own setPosition: the client moves, the event says the frame. */
const moveClient = (x: number, y: number) => {
  wm.client = { x, y };
  wm.moved?.(frameOf(wm.client));
};

vi.mock("@tauri-apps/api/window", async (importOriginal) => {
  const real = await importOriginal<typeof TauriWindow>();
  const monitor = {
    name: "eDP-1",
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    workArea: { position: { x: WORK.x, y: WORK.y }, size: { width: WORK.width, height: WORK.height } },
    get scaleFactor() {
      return wm.scale;
    },
  };
  return {
    ...real,
    availableMonitors: async () => [monitor],
    primaryMonitor: async () => monitor,
    cursorPosition: async () => ({ x: 10, y: 10 }),
    getCurrentWindow: () => ({
      innerPosition: async () => {
        if (wm.failReads) throw new Error("window gone");
        const at = { ...wm.client };
        if (wm.held) await new Promise<void>((r) => wm.held!.push(r));
        return at;
      },
      outerPosition: async () => frameOf(wm.client),
      innerSize: async () => ({ ...CLIENT }),
      outerSize: async () => ({ width: CLIENT.width, height: CLIENT.height + FRAME_TOP }),
      setPosition: async (p: { x: number; y: number }) => {
        moveClient(p.x, p.y + (wm.placesFrame ? FRAME_TOP : 0));
        const late = wm.lateTo;
        wm.lateTo = null;
        if (late) moveClient(late.x, late.y);
      },
      startDragging: async () => undefined,
      onMoved: async (cb: (e: { payload: { x: number; y: number } }) => void) => {
        wm.moved = (p) => cb({ payload: p });
        return () => (wm.moved = null);
      },
    }),
  };
});

const { tauriPetWindow } = await import("../src/pet/window-api.js");
const { DRAG_QUIET_MS, PetMotion } = await import("../src/pet/motion.js");
const { WALK } = await import("../src/pet/walk.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const press = (el: HTMLElement, type: string, x: number, y: number) =>
  el.dispatchEvent(new MouseEvent(type, { button: 0, screenX: x, screenY: y }));

const launch = (storage = memory()) => {
  let t = 0;
  const motion = new PetMotion(tauriPetWindow(), {
    storage,
    walkEnabled: () => true,
    onMoved: () => undefined,
    onClick: () => undefined,
    rand: () => 0.5,
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  const ctx = { level: null, fullscreen: false, dnd: false, quietHours: false, lowEnergy: false };
  // A hit box away from the cursor (10, 10), so it never counts as hovering.
  const hit = { x: 1000, y: 900, width: 50, height: 50 };
  const at = (now: number) => {
    t = now;
    return motion.update(now, { hit, scale: 1, state: "idle", ctx });
  };
  return { motion, storage, at };
};

beforeEach(() => {
  wm.client = { x: 900, y: 400 };
  wm.moved = null;
  wm.failReads = false;
  wm.placesFrame = false;
  wm.lateTo = null;
  wm.scale = 1;
  FRAME_TOP = 37;
  wm.held = null;
});

describe("pet placement through the Tauri window API (frame taller than the client)", () => {
  it("rests the pet's client area on the work area's bottom edge", async () => {
    const { motion } = launch();
    await motion.start();
    await flush();
    motion.stop();
    // Feet on the edge (y 1080), 24 px from the right: not 37 px above it (y 1043).
    expect(wm.client.y + CLIENT.height).toBe(WORK.y + WORK.height);
    expect(wm.client).toEqual(CORNER);
  });

  it("is still on the floor after its own moves echo back, so it walks again after a walk", async () => {
    const { motion, at } = launch();
    await motion.start();
    expect(at(WALK.firstAfterMs).play).toBe("walk");
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
    }
    expect(motion.walking).toBe(false);
    expect(wm.client.y).toBe(CORNER.y);
    // The next turn (gap = 60 s + 0.5 × 120 s): only a pet standing on the taskbar takes it.
    expect(at(WALK.firstAfterMs + 120_000).play).toBe("walk");
    motion.stop();
  });

  it("saves the client spot it was dragged to, and the next launch puts it back there", async () => {
    const first = launch();
    await first.motion.start();
    const el = document.createElement("div");
    first.motion.attach(el);
    press(el, "pointerdown", 100, 100);
    press(el, "pointermove", 120, 100);
    moveClient(600, CORNER.y);
    await flush();
    first.at(1000);
    first.at(1000 + DRAG_QUIET_MS + 1);
    await flush();
    await flush();
    first.motion.stop();
    expect(Object.values(JSON.parse(first.storage.getItem("chalito-pet-spot")!))).toEqual([{ x: 600, y: CORNER.y }]);

    wm.client = { x: 900, y: 400 };
    const next = launch(first.storage);
    await next.motion.start();
    next.motion.stop();
    expect(wm.client).toEqual({ x: 600, y: CORNER.y });
  });

  it("hands onMoved the client's corner, not the frame's corner in the payload", async () => {
    const seen: { x: number; y: number }[] = [];
    await tauriPetWindow().onMoved((p) => seen.push(p));
    moveClient(500, 700);
    await flush();
    moveClient(510, 710);
    await flush();
    expect(seen).toEqual([
      { x: 500, y: 700 },
      { x: 510, y: 710 },
    ]);
  });

  it("warns and skips the callback when the position can't be read after a move", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: { x: number; y: number }[] = [];
    await tauriPetWindow().onMoved((p) => seen.push(p));
    wm.failReads = true;
    moveClient(500, 700);
    await flush();
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith("pet: window position unavailable after a move", expect.any(Error));
    warn.mockRestore();
  });

  it("puts a spot saved by older builds (the frame's corner, 37 px up) back on the floor", async () => {
    const storage = memory();
    storage.setItem("chalito-pet-spot", JSON.stringify({ "0,0,1920x1080": { x: 600, y: 783 } }));
    const { motion } = launch(storage);
    await motion.start();
    motion.stop();
    expect(wm.client).toEqual({ x: 600, y: CORNER.y });
  });

  it("corrects once when the WM puts the frame, not the client, where it was asked", async () => {
    wm.placesFrame = true;
    const { motion } = launch();
    await motion.start();
    motion.stop();
    expect(wm.client).toEqual(CORNER);
  });

  it("keeps that correction for its walks on a frame-placing WM, so it stays on the floor and walks again", async () => {
    wm.placesFrame = true;
    const { motion, at } = launch();
    await motion.start();
    expect(at(WALK.firstAfterMs).play).toBe("walk");
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
    }
    expect(motion.walking).toBe(false);
    expect(wm.client.y).toBe(CORNER.y);
    expect(at(WALK.firstAfterMs + 120_000).play).toBe("walk");
    motion.stop();
  });

  it("doesn't shift when the late WM placement is farther off than a frame, and walks stay on the floor", async () => {
    // Mutter placing a fresh window late, elsewhere: ask for the spot again, keep no offset.
    wm.lateTo = { x: 300, y: 200 };
    const { motion, at } = launch();
    await motion.start();
    expect(wm.client).toEqual(CORNER);
    expect(at(WALK.firstAfterMs).play).toBe("walk");
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
    }
    expect(wm.client.y).toBe(CORNER.y);
    motion.stop();
  });

  it("on a HiDPI screen (scale 2) takes a 74 px physical title bar for a frame too", async () => {
    wm.placesFrame = true;
    wm.scale = 2;
    FRAME_TOP = 74;
    const { motion } = launch();
    await motion.start();
    motion.stop();
    // Feet on the floor; the 2 × 24 px margin from the right.
    expect(wm.client).toEqual({ x: WORK.x + WORK.width - CLIENT.width - 48, y: CORNER.y });
  });

  it("doesn't keep a small WM nudge up as a frame offset (an Alt-drag during the recheck)", async () => {
    // The WM moves the client 20 px up right after placement: not a frame, which only pushes it down.
    wm.lateTo = { x: CORNER.x, y: CORNER.y - 20 };
    const { motion, at } = launch();
    await motion.start();
    expect(wm.client).toEqual(CORNER);
    expect(at(WALK.firstAfterMs).play).toBe("walk");
    for (let t = WALK.firstAfterMs; t < WALK.firstAfterMs + 10_000; t += 40) {
      at(t);
      await flush();
    }
    expect(wm.client.y).toBe(CORNER.y);
    motion.stop();
  });

  it("drops a position read that comes back after a newer one, and any after unlisten", async () => {
    wm.held = [];
    const seen: { x: number; y: number }[] = [];
    const off = await tauriPetWindow().onMoved((p) => seen.push(p));
    moveClient(500, 700);
    moveClient(510, 710);
    const [older, newer] = wm.held;
    newer!();
    await flush();
    older!();
    await flush();
    expect(seen).toEqual([{ x: 510, y: 710 }]);
    moveClient(520, 720);
    off();
    wm.held[2]!();
    await flush();
    expect(seen).toEqual([{ x: 510, y: 710 }]);
  });
});
