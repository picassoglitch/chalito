import type { Locale, ScreenMode } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import { DEFAULT_SCREEN, type Policy } from "../policy/schema.js";

/**
 * Turning remote screen on or off (view, or view + control). Exactly like computer control
 * (computer/toggle.ts): ON only on the device itself, through `chalito screen enable` in a real
 * terminal or the desktop panel over the agent's local IPC; OS authentication first, then two
 * confirmations and a typed phrase. No remote command reaches this (packages/protocol
 * command.ts has no shape for it); remote surfaces can only turn it off (`policy.tighten`).
 */

export interface ScreenPrompter {
  first(examples: string[]): Promise<boolean>;
  second(risk: string): Promise<boolean>;
  typed(phrase: string): Promise<string>;
}

/** Bumped when the copy changes; the audit records which version the person accepted. */
export const SCREEN_COPY_VERSION = 1;

type Copy = { examples: string[]; risk: string; phrase: string };

export const SCREEN_COPY: Record<Locale, Record<ScreenMode, Copy>> = {
  es: {
    view: {
      examples: [
        "Ver esta pantalla desde tu navegador de confianza, en vivo",
        "Incluye todo lo visible: mensajes, documentos y contraseñas en pantalla",
      ],
      risk: "Cada sesión pedirá tu aprobación con passkey en un dispositivo de confianza. La imagen va directo entre tu navegador y esta computadora, cifrada; Chalito no la ve. Mientras alguien mira verás un aviso en pantalla; lo detienes con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
      phrase: "VER MI PANTALLA",
    },
    control: {
      examples: [
        "Ver esta pantalla desde tu navegador de confianza, en vivo",
        "Mover el mouse, hacer clic y escribir en cualquier app abierta, desde lejos",
        "Incluye todo lo visible: mensajes, documentos y contraseñas en pantalla",
      ],
      risk: "Cada sesión pedirá tu aprobación con passkey en un dispositivo de confianza. La imagen y el teclado van directo entre tu navegador y esta computadora, cifrados; Chalito no los ve. Mientras haya una sesión verás un aviso en pantalla; la detienes con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
      phrase: "CONTROLAR MI PANTALLA",
    },
  },
  en: {
    view: {
      examples: [
        "See this screen live from your trusted browser",
        "That includes everything visible: messages, documents and passwords on screen",
      ],
      risk: "Every session will ask for your passkey approval on a trusted device. The picture goes straight between your browser and this computer, encrypted; Chalito can't see it. While someone is watching you'll see a notice on screen; stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
      phrase: "VIEW MY SCREEN",
    },
    control: {
      examples: [
        "See this screen live from your trusted browser",
        "Move the mouse, click and type in any open app, from afar",
        "That includes everything visible: messages, documents and passwords on screen",
      ],
      risk: "Every session will ask for your passkey approval on a trusted device. The picture and your keystrokes go straight between your browser and this computer, encrypted; Chalito can't see them. While a session is on you'll see a notice on screen; stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
      phrase: "CONTROL MY SCREEN",
    },
  },
};

export interface ScreenToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  prompter: ScreenPrompter;
  locale: Locale;
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type ScreenEnableResult = { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" };

/** What is on now: "off", "view" or "control" (control implies view). */
export const screenLevel = (s: Policy["screen"]): "off" | ScreenMode =>
  s?.control ? "control" : s?.view ? "view" : "off";

export const enableScreen = async (d: ScreenToggleDeps, mode: ScreenMode): Promise<ScreenEnableResult> => {
  const level = screenLevel(d.policy.get().screen);
  if (level === "control" || level === mode) return { ok: false, reason: "already_on" };
  if (
    !(await d.osAuth.verify(
      mode === "control" ? "Chalito: activar el control remoto de la pantalla" : "Chalito: activar ver la pantalla",
    ))
  )
    return { ok: false, reason: "os_auth_failed" };
  const copy = SCREEN_COPY[d.locale][mode];
  if (!(await d.prompter.first(copy.examples))) return { ok: false, reason: "cancelled" };
  if (!(await d.prompter.second(copy.risk))) return { ok: false, reason: "cancelled" };
  if ((await d.prompter.typed(copy.phrase)).trim() !== copy.phrase) return { ok: false, reason: "cancelled" };
  const cur = d.policy.get();
  const prev = cur.screen ?? DEFAULT_SCREEN;
  await d.policy.set(
    {
      ...cur,
      screen: {
        view: true,
        control: mode === "control",
        maxFps: prev.maxFps,
        maxInputsPerMinute: prev.maxInputsPerMinute,
        maxSessionMinutes: prev.maxSessionMinutes,
      },
    },
    "local",
  );
  await d.emit("screen.enabled", { mode, copyVersion: SCREEN_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

/**
 * Always allowed locally, no OS prompt: it only makes things safer. `control` drops back to
 * view only; `all` turns remote screen off.
 */
export const disableScreen = async (
  d: Pick<ScreenToggleDeps, "policy" | "emit">,
  what: "control" | "all",
  by: string,
): Promise<boolean> => {
  const cur = d.policy.get();
  const level = screenLevel(cur.screen);
  if (level === "off" || (what === "control" && level !== "control")) return false;
  await d.policy.set(
    { ...cur, screen: { ...cur.screen!, control: false, view: what === "control" ? cur.screen!.view : false } },
    "local",
  );
  await d.emit("screen.disabled", { what, by });
  return true;
};
