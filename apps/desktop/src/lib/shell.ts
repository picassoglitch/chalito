import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import type { Level } from "@chalito/protocol";
import type { Rect, WindowGeometry } from "./hitbox.js";
import type { PetContext } from "./pet-context.js";

const PET_CONTEXT = "chalito://pet-context";
const PET_ACK = "chalito://pet-ack";

/**
 * Everything the webviews ask of the native side, behind one interface so components and
 * tests don't touch Tauri. `browserShell` is a no-op stand-in for `vite dev` in a browser.
 */
export interface DesktopShell {
  setHitBox(r: Rect | null): Promise<void>;
  /** Refused natively below L4. */
  focusPet(level: Level): Promise<void>;
  idleMs(): Promise<number>;
  touchActivity(): Promise<void>;
  showWindow(label: "panel" | "room"): Promise<void>;
  geometry(): Promise<WindowGeometry>;
  sendPetContext(ctx: PetContext): Promise<void>;
  onPetContext(cb: (ctx: PetContext) => void): Promise<() => void>;
  sendPetAck(): Promise<void>;
  onPetAck(cb: () => void): Promise<() => void>;
}

export const tauriShell: DesktopShell = {
  setHitBox: (rect) => invoke("set_hit_box", { rect }),
  focusPet: (level) => invoke("focus_pet", { level }),
  idleMs: () => invoke<number>("idle_ms"),
  touchActivity: () => invoke("touch_activity"),
  showWindow: async (label) => {
    const w = await Window.getByLabel(label);
    if (!w) return;
    await w.show();
    await w.unminimize();
    await w.setFocus();
  },
  geometry: async () => {
    const w = getCurrentWindow();
    const [pos, scale] = await Promise.all([w.innerPosition(), w.scaleFactor()]);
    return { innerX: pos.x, innerY: pos.y, scale };
  },
  sendPetContext: (ctx) => emitTo("pet", PET_CONTEXT, ctx),
  onPetContext: (cb) => listen<PetContext>(PET_CONTEXT, (e) => cb(e.payload)),
  sendPetAck: () => emitTo("panel", PET_ACK),
  onPetAck: (cb) => listen(PET_ACK, () => cb()),
};

const none = () => Promise.resolve();
const noListen = () => Promise.resolve(() => undefined);

export const browserShell: DesktopShell = {
  setHitBox: none,
  focusPet: none,
  idleMs: () => Promise.resolve(0),
  touchActivity: none,
  showWindow: none,
  geometry: () => Promise.resolve({ innerX: 0, innerY: 0, scale: 1 }),
  sendPetContext: none,
  onPetContext: noListen,
  sendPetAck: none,
  onPetAck: noListen,
};

export const shell = (): DesktopShell => (isTauri() ? tauriShell : browserShell);
