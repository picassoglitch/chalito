import {
  PhysicalPosition,
  availableMonitors,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import type { PetWindowApi } from "./motion.js";

/** The pet window through Tauri's JS API; moving it needs the `pet-move` capability. */
export const tauriPetWindow = (): PetWindowApi => {
  const w = getCurrentWindow();
  return {
    cursor: async () => {
      const p = await cursorPosition();
      return { x: p.x, y: p.y };
    },
    position: async () => {
      const p = await w.outerPosition();
      return { x: p.x, y: p.y };
    },
    size: async () => {
      const s = await w.outerSize();
      return { width: s.width, height: s.height };
    },
    screens: async () => {
      const [all, main] = await Promise.all([availableMonitors(), primaryMonitor()]);
      return all.map((m) => ({
        primary: !!main && m.position.x === main.position.x && m.position.y === main.position.y,
        bounds: { x: m.position.x, y: m.position.y, width: m.size.width, height: m.size.height },
        work: {
          x: m.workArea.position.x,
          y: m.workArea.position.y,
          width: m.workArea.size.width,
          height: m.workArea.size.height,
        },
        scale: m.scaleFactor,
      }));
    },
    setPosition: (x, y) => w.setPosition(new PhysicalPosition(x, y)),
    startDragging: () => w.startDragging(),
    onMoved: (cb) => w.onMoved((e) => cb({ x: e.payload.x, y: e.payload.y })),
  };
};
