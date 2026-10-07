import { roomWindowDeps, tauriRoomWindowIo } from "../lib/room-window.js";
import { readEnv } from "../lib/session.js";
import { shell } from "../lib/shell.js";
import { companionCardSource } from "../lib/custom-card.js";
import { ownCosmetics } from "./cosmetics.js";
import { startPet } from "./scene.js";

const canvas = document.createElement("canvas");
canvas.className = "pet-canvas";
document.getElementById("root")!.append(canvas);

/** Like the room window, the pet borrows the panel's device session (null until it signs in). */
const env = readEnv();
const deps = async () => (env ? roomWindowDeps(await tauriRoomWindowIo(env)) : null);
const cosmetics = async () => {
  const d = await deps();
  return d ? ownCosmetics(d) : null;
};
startPet(canvas, shell(), cosmetics, companionCardSource(deps));
