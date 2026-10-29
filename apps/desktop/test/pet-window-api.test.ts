import type * as TauriWindow from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The owner's X11 desktop (2026-10-28): 1920×1080, _NET_WORKAREA 67,32,1853,1048, and a pet window
// whose outer frame (297 px) is 37 px taller than its 260 px client, all of it above the client.
const WORK = { x: 67, y: 32, width: 1853, height: 1048 };
const CLIENT = { width: 220, height: 260 };
const FRAME_TOP = 37;
const CORNER = { x: WORK.x + WORK.width - CLIENT.width - 24, y: WORK.y + WORK.height - CLIENT.height };

/** The WM as tao reports it there: setPosition places the client, move events carry the frame's corner. */
const wm = {
  client: { x: 900, y: 400 },
  moved: null as ((p: { x: number; y: number }) => void) | null,
  failReads: false,
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
    scaleFactor: 1,
  };
  return {
    ...real,
    availableMonitors: async () => [monitor],
    primaryMonitor: async () => monitor,
    cursorPosition: async () => ({ x: 10, y: 10 }),
    getCurrentWindow: () => ({
      innerPosition: async () => {
        if (wm.failReads) throw new Error("window gone");
        return { ...wm.client };
      },
      outerPosition: async () => frameOf(wm.client),
      innerSize: async () => ({ ...CLIENT }),
      outerSize: async () => ({ width: CLIENT.width, height: CLIENT.height + FRAME_TOP }),
      setPosition: async (p: { x: number; y: number }) => moveClient(p.x, p.y),
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
});
