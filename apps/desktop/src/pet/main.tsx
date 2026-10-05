import { roomWindowDeps, tauriRoomWindowIo } from "../lib/room-window.js";
import { readEnv } from "../lib/session.js";
import { shell } from "../lib/shell.js";
import { ownCosmetics } from "./cosmetics.js";
import { startPet } from "./scene.js";

const canvas = document.createElement("canvas");
canvas.className = "pet-canvas";
document.getElementById("root")!.append(canvas);

/** Like the room window, the pet borrows the panel's device session (null until it signs in). */
const env = readEnv();
const cosmetics = async () => {
  if (!env) return null;
  const deps = await roomWindowDeps(await tauriRoomWindowIo(env));
  return deps ? ownCosmetics(deps) : null;
};
startPet(canvas, shell(), cosmetics);
