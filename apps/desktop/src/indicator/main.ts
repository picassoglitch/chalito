import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { detectLocale } from "../lib/i18n.js";

/**
 * The always-on-top notice the native side shows while a session controls this computer
 * (src-tauri/src/computer.rs). The agent only acts while this window is on screen. Its button is
 * one of the kill switches, next to Ctrl+Alt+Esc and the tray's "Detener control".
 */
const COPY: Record<"es" | "en", { title: string; detail: string; stop: string }> = {
  es: { title: "Chalito está controlando este equipo", detail: "Ctrl+Alt+Esc para detener", stop: "Detener control" },
  en: { title: "Chalito is controlling this computer", detail: "Ctrl+Alt+Esc to stop", stop: "Stop control" },
};

export const indicatorText = (labels: string[], copy: { detail: string }) =>
  labels.length ? `${copy.detail} · ${labels.join(", ")}` : copy.detail;

const copy = COPY[detectLocale()];
const title = document.getElementById("title");
const detail = document.getElementById("detail");
const stop = document.getElementById("stop");
if (title) title.textContent = copy.title;
if (detail) detail.textContent = copy.detail;
if (stop) {
  stop.textContent = copy.stop;
  stop.addEventListener("click", () => {
    if (isTauri()) void invoke("computer_stop");
  });
}
if (isTauri())
  void listen<string[]>("computer-status", (e) => {
    if (detail) detail.textContent = indicatorText(e.payload, copy);
  });
