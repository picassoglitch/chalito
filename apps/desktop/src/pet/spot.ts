import type { Rect } from "../lib/hitbox.js";

/** A monitor as the pet needs it, in PHYSICAL px: the whole screen and its work area (no taskbar/dock). */
export interface Screen {
  bounds: Rect;
  work: Rect;
  scale: number;
  primary?: boolean;
}

export interface Spot {
  x: number;
  y: number;
}

const KEY = "chalito-pet-spot";
/** Spots kept for this many monitor setups (laptop alone, docked…); the oldest goes first. */
export const MAX_SETUPS = 8;

/** Names a monitor setup by its screens' bounds, so a spot saved docked isn't reused undocked. */
export const setupKey = (screens: readonly Screen[]): string =>
  screens
    .map((s) => `${s.bounds.x},${s.bounds.y},${s.bounds.width}x${s.bounds.height}`)
    .sort()
    .join("|");

const inside = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

/** The screen whose work area holds this point, if any. */
export const screenAt = (screens: readonly Screen[], x: number, y: number): Screen | null =>
  screens.find((s) => inside(s.work, x, y)) ?? null;

/** Keeps a window of this size inside an area (top-left when it doesn't fit). */
export const clampInto = (spot: Spot, win: { width: number; height: number }, area: Rect): Spot => ({
  x: Math.max(area.x, Math.min(spot.x, area.x + area.width - win.width)),
  y: Math.max(area.y, Math.min(spot.y, area.y + area.height - win.height)),
});

/** A saved spot still usable now: its centre on some work area (a gone monitor fails), pulled fully
 * inside it. Null = keep the default corner. */
export const validSpot = (
  spot: Spot | null,
  win: { width: number; height: number },
  screens: readonly Screen[],
): Spot | null => {
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return null;
  const s = screenAt(screens, spot.x + win.width / 2, spot.y + win.height / 2);
  return s ? clampInto(spot, win, s.work) : null;
};

/** Gap between the pet and the work area's right edge, in logical px (as Rust's `PET_MARGIN`). */
export const PET_MARGIN = 24;

/** Bottom-right of a work area, feet on the taskbar: Rust's `pet_spot`, redone with the mapped size. */
export const cornerSpot = (screen: Screen, win: { width: number; height: number }): Spot => {
  const { work } = screen;
  const margin = Math.round(PET_MARGIN * screen.scale);
  return {
    x: work.x + Math.max(0, work.width - win.width - margin),
    y: work.y + Math.max(0, work.height - win.height),
  };
};

/** Saved spots near the floor go onto it, in logical px: older builds saved the frame's corner,
 * up to a title bar (37 px on the owner's X11) above where the pet stood. */
export const FLOOR_SNAP = 48;

const snapToFloor = (spot: Spot, win: { width: number; height: number }, screens: readonly Screen[]): Spot => {
  const s = screenAt(screens, spot.x + win.width / 2, spot.y + win.height / 2);
  if (!s) return spot;
  const floor = s.work.y + s.work.height - win.height;
  return Math.abs(spot.y - floor) <= FLOOR_SNAP * s.scale ? { x: spot.x, y: floor } : spot;
};

/** Launch spot: the saved one if still on a screen (snapped onto a floor it nearly touches), else the
 * primary screen's corner. */
export const launchSpot = (
  saved: Spot | null,
  win: { width: number; height: number },
  screens: readonly Screen[],
  current: Spot,
): Spot | null => {
  const ok = validSpot(saved, win, screens);
  if (ok) return snapToFloor(ok, win, screens);
  const s =
    screens.find((x) => x.primary) ??
    screenAt(screens, current.x + win.width / 2, current.y + win.height / 2) ??
    screens[0];
  return s ? cornerSpot(s, win) : null;
};

type Saved = Record<string, Spot>;

const read = (storage: Pick<Storage, "getItem">): Saved => {
  try {
    const v = JSON.parse(storage.getItem(KEY) ?? "null") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Saved) : {};
  } catch {
    return {};
  }
};

export const loadSpot = (key: string, storage: Pick<Storage, "getItem">): Spot | null => {
  const s = read(storage)[key];
  return s && typeof s.x === "number" && typeof s.y === "number" ? { x: s.x, y: s.y } : null;
};

export const saveSpot = (key: string, spot: Spot, storage: Pick<Storage, "getItem" | "setItem">): void => {
  const all = read(storage);
  delete all[key];
  all[key] = { x: Math.round(spot.x), y: Math.round(spot.y) };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SETUPS))) delete all[k];
  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the pet stays where it was put for this run.
  }
};
