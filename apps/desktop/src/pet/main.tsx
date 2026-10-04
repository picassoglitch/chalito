import { shell } from "../lib/shell.js";
import { startPet } from "./scene.js";

const canvas = document.createElement("canvas");
canvas.className = "pet-canvas";
document.getElementById("root")!.append(canvas);
startPet(canvas, shell());
