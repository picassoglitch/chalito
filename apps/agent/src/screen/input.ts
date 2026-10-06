import type { ScreenInput } from "@chalito/protocol";
import { parseCombo } from "../computer/tools.js";
import type { DisplayInfo, MouseButton, NativeDriver } from "../computer/native.js";

/**
 * Applies one remote-viewer input event to this computer (control mode only; screen/manager.ts
 * checks the grant, the indicator and the rate first). Coordinates arrive normalised (0..1 of the
 * shown display) and are mapped to the input layer's coordinates for that display.
 */

export const toDisplay = (d: DisplayInfo, x: number, y: number): { x: number; y: number } => ({
  x: Math.round(d.x + Math.min(1, Math.max(0, x)) * Math.max(0, d.width - 1)),
  y: Math.round(d.y + Math.min(1, Math.max(0, y)) * Math.max(0, d.height - 1)),
});

/** Text is typed in chunks so a kill between chunks stops it mid-text. */
export const TEXT_CHUNK = 16;

/** Which counter an input goes to: pointer moves are coalesced, everything else is counted. */
export const isCounted = (i: ScreenInput): boolean => i.t !== "move";

export const applyInput = async (
  n: NativeDriver,
  d: DisplayInfo,
  i: ScreenInput,
  held: Set<MouseButton>,
  live: () => boolean,
): Promise<void> => {
  switch (i.t) {
    case "move": {
      const p = toDisplay(d, i.x, i.y);
      n.move(p.x, p.y);
      return;
    }
    case "button": {
      const p = toDisplay(d, i.x, i.y);
      n.move(p.x, p.y);
      n.button(i.down, i.button);
      if (i.down) held.add(i.button);
      else held.delete(i.button);
      return;
    }
    case "click": {
      const p = toDisplay(d, i.x, i.y);
      n.move(p.x, p.y);
      n.click(i.button, i.double);
      return;
    }
    case "scroll":
      // robotjs: positive y scrolls up; the viewer's positive dy scrolls down (like the MCP tool).
      n.scroll(i.dx, -i.dy);
      return;
    case "key": {
      const combo = parseCombo(i.keys);
      if (!combo) throw new Error("bad_key");
      n.key(combo.key, combo.modifiers);
      return;
    }
    case "text": {
      const chars = [...i.text];
      for (let k = 0; k < chars.length; k += TEXT_CHUNK) {
        if (!live()) return;
        n.type(chars.slice(k, k + TEXT_CHUNK).join(""));
        await Promise.resolve();
      }
      return;
    }
  }
};

/** Lets go of every button the remote viewer held down (kill, close, disable). */
export const releaseAll = (n: NativeDriver | null, held: Set<MouseButton>): void => {
  if (!n) return held.clear();
  for (const b of held) {
    try {
      n.button(false, b);
    } catch {
      /* best effort */
    }
  }
  held.clear();
};
