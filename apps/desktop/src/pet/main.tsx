import { roomWindowDeps, tauriRoomWindowIo } from "../lib/room-window.js";
import { loadStored, readEnv } from "../lib/session.js";
import { shell } from "../lib/shell.js";
import { companionCardSource } from "../lib/custom-card.js";
import { ownCosmetics } from "./cosmetics.js";
import { isTauri } from "@tauri-apps/api/core";
import { startPet } from "./scene.js";
import { tauriPetWindow } from "./window-api.js";
import { BoardLink } from "../lib/board/link.js";
import { tauriBoardPort } from "../lib/board/tauri-port.js";
import { idbPairStore } from "../lib/board/pairing.js";
import { localCardErrors } from "../lib/board/card-errors.js";

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
// BOARD_LINK: the pet window owns the LCD's card and face; the panel owns its approvals screen.
const board = isTauri() ? new BoardLink(tauriBoardPort, idbPairStore(), { cardErrors: localCardErrors() }) : null;
board?.start();
startPet(
  canvas,
  shell(),
  cosmetics,
  env ? companionCardSource(deps, () => loadStored() !== null) : null,
  isTauri() ? tauriPetWindow() : null,
  board,
);
