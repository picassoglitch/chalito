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
    // The client area everywhere: on the owner's X11 WM setPosition places the client but outer*
    // report the frame (37 px taller, all above); mixing the two floated the pet 37 px up.
    position: async () => {
      const p = await w.innerPosition();
      return { x: p.x, y: p.y };
    },
    size: async () => {
      const s = await w.innerSize();
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
    // The payload is the frame's corner on X11 (tao sends root_origin), not the client's that
    // setPosition takes, so re-read the client position.
    onMoved: async (cb) => {
      // Reads resolve on a thread pool, so drop one older than a reply already handed on, and any after unlisten.
      let asked = 0;
      let handed = 0;
      let live = true;
      const off = await w.onMoved(() => {
        const n = ++asked;
        w.innerPosition().then(
          (p) => {
            if (!live || n < handed) return;
            handed = n;
            cb({ x: p.x, y: p.y });
          },
          (err: unknown) => console.warn("pet: window position unavailable after a move", err),
        );
      });
      return () => {
        live = false;
        off();
      };
    },
  };
};
