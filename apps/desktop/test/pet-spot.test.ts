import { describe, expect, it } from "vitest";
import {
  MAX_SETUPS,
  clampInto,
  cornerSpot,
  launchSpot,
  loadSpot,
  saveSpot,
  setupKey,
  validSpot,
  type Screen,
} from "../src/pet/spot.js";

const laptop: Screen = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  work: { x: 0, y: 0, width: 1920, height: 1040 },
  scale: 1,
};
const leftMonitor: Screen = {
  bounds: { x: -2560, y: -200, width: 2560, height: 1440 },
  work: { x: -2560, y: -175, width: 2560, height: 1415 },
  scale: 1,
};
const WIN = { width: 220, height: 260 };

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("saved pet spot", () => {
  it("a monitor setup is named by its screens, whatever order the OS lists them", () => {
    expect(setupKey([laptop, leftMonitor])).toBe(setupKey([leftMonitor, laptop]));
    expect(setupKey([laptop])).not.toBe(setupKey([laptop, leftMonitor]));
  });

  it("a spot on a screen is used as is", () => {
    expect(validSpot({ x: 400, y: 780 }, WIN, [laptop])).toEqual({ x: 400, y: 780 });
    expect(validSpot({ x: -1000, y: 900 }, WIN, [laptop, leftMonitor])).toEqual({ x: -1000, y: 900 });
  });

  it("a spot on a monitor that's gone, or nowhere, falls back to the corner (null)", () => {
    expect(validSpot({ x: -1000, y: 900 }, WIN, [laptop])).toBeNull();
    expect(validSpot({ x: 5000, y: 5000 }, WIN, [laptop])).toBeNull();
    expect(validSpot(null, WIN, [laptop])).toBeNull();
    expect(validSpot({ x: Number.NaN, y: 0 }, WIN, [laptop])).toBeNull();
    expect(validSpot({ x: 400, y: 780 }, WIN, [])).toBeNull();
  });

  it("a spot half off its screen (or under the taskbar) is pulled fully inside the work area", () => {
    expect(validSpot({ x: 1800, y: 900 }, WIN, [laptop])).toEqual({ x: 1700, y: 780 });
    expect(validSpot({ x: -100, y: -50 }, WIN, [laptop])).toEqual({ x: 0, y: 0 });
    expect(clampInto({ x: 50, y: 50 }, { width: 300, height: 300 }, { x: 0, y: 0, width: 200, height: 200 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("is kept per setup, the oldest setups dropped first; bad storage reads as none", () => {
    const s = memory();
    saveSpot("docked", { x: -1000.4, y: 900 }, s);
    saveSpot("laptop", { x: 400, y: 780 }, s);
    expect(loadSpot("docked", s)).toEqual({ x: -1000, y: 900 });
    expect(loadSpot("laptop", s)).toEqual({ x: 400, y: 780 });
    expect(loadSpot("other", s)).toBeNull();
    for (let i = 0; i < MAX_SETUPS; i++) saveSpot(`k${i}`, { x: i, y: i }, s);
    expect(loadSpot("docked", s)).toBeNull();
    expect(loadSpot(`k${MAX_SETUPS - 1}`, s)).toEqual({ x: MAX_SETUPS - 1, y: MAX_SETUPS - 1 });
    s.m.set("chalito-pet-spot", "{not json");
    expect(loadSpot("laptop", s)).toBeNull();
    s.m.set("chalito-pet-spot", JSON.stringify({ laptop: { x: "1", y: 2 } }));
    expect(loadSpot("laptop", s)).toBeNull();
  });

  it("saving again moves a setup to the newest", () => {
    const s = memory();
    saveSpot("keep", { x: 1, y: 1 }, s);
    for (let i = 0; i < MAX_SETUPS - 1; i++) saveSpot(`k${i}`, { x: i, y: i }, s);
    saveSpot("keep", { x: 2, y: 2 }, s);
    saveSpot("one-more", { x: 3, y: 3 }, s);
    expect(loadSpot("keep", s)).toEqual({ x: 2, y: 2 });
    expect(loadSpot("k0", s)).toBeNull();
  });
});

describe("launch spot", () => {
  const gnome: Screen = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    work: { x: 67, y: 32, width: 1853, height: 1048 },
    scale: 1,
  };

  it("the corner matches Rust's pet_spot, with the size the window really has once mapped", () => {
    expect(cornerSpot(laptop, WIN)).toEqual({ x: 1676, y: 780 });
    expect(cornerSpot(gnome, { width: 220, height: 297 })).toEqual({ x: 1676, y: 783 });
    expect(cornerSpot({ ...laptop, scale: 2 }, { width: 440, height: 520 })).toEqual({ x: 1432, y: 520 });
    expect(cornerSpot(laptop, { width: 3000, height: 3000 })).toEqual({ x: 0, y: 0 });
  });

  it("saved spot first; else the primary screen's corner, else the screen it's on, else the first", () => {
    const here = { x: 1000, y: 700 };
    expect(launchSpot({ x: 400, y: 780 }, WIN, [laptop], here)).toEqual({ x: 400, y: 780 });
    expect(launchSpot(null, WIN, [leftMonitor, { ...laptop, primary: true }], { x: -1000, y: 500 })).toEqual({
      x: 1676,
      y: 780,
    });
    expect(launchSpot(null, WIN, [laptop, leftMonitor], { x: -1000, y: 500 })).toEqual(cornerSpot(leftMonitor, WIN));
    expect(launchSpot(null, WIN, [laptop, leftMonitor], { x: 9000, y: 9000 })).toEqual(cornerSpot(laptop, WIN));
    expect(launchSpot(null, WIN, [], here)).toBeNull();
  });
});
