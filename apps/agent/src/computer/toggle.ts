import type { Locale } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import { DEFAULT_COMPUTER, type Policy } from "../policy/schema.js";

/**
 * Turning computer control on or off. Like Developer mode (devmode.ts), turning it ON happens
 * only on the device itself: the CLI in a terminal the person types in (`chalito computer
 * enable`) or the desktop panel through the agent's local IPC. Both go through `enable`: OS
 * authentication first (password / biometric), then two confirmations and a typed phrase.
 * Cancelling at any step changes nothing. No remote command reaches this (see
 * packages/protocol/src/command.ts); remote surfaces can only turn it off (`policy.tighten`).
 *
 * The switch lives in the signed policy (policy.yaml + policy.lock, keychain-anchored), so a
 * shell write can't flip it, and `chalito policy edit` refuses to turn it on.
 */

export interface ComputerPrompter {
  /** 1: "Turn on computer control?" with concrete examples of what it allows. */
  first(examples: string[]): Promise<boolean>;
  /** 2: restates the risk and how to stop it. */
  second(risk: string): Promise<boolean>;
  /** 3: the person types the phrase. */
  typed(phrase: string): Promise<string>;
}

/** Bumped when the copy changes; the audit records which version the person accepted. */
export const COMPUTER_COPY_VERSION = 1;

export const COMPUTER_COPY: Record<Locale, { examples: string[]; risk: string; phrase: string }> = {
  es: {
    examples: [
      "Ver todo lo que hay en tu pantalla, incluidos mensajes y contraseñas visibles",
      "Mover el mouse, hacer clic y escribir en cualquier app abierta",
      "Abrir, cerrar o cambiar de ventana",
    ],
    risk: "Cada sesión pedirá tu aprobación con passkey en un dispositivo de confianza. Mientras tenga el control verás un aviso en pantalla; lo detienes con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
    phrase: "CONTROLAR MI EQUIPO",
  },
  en: {
    examples: [
      "See everything on your screen, including visible messages and passwords",
      "Move the mouse, click and type in any open app",
      "Open, close or switch windows",
    ],
    risk: "Every session will ask for your passkey approval on a trusted device. While it has control you'll see a notice on screen; stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
    phrase: "CONTROL MY COMPUTER",
  },
};

export interface ComputerToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  prompter: ComputerPrompter;
  locale: Locale;
  /** Audit sink (agent audit trail); the daemon also reports `computer.changed` on the policy change. */
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type ComputerEnableResult = { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" };

export const enableComputer = async (d: ComputerToggleDeps): Promise<ComputerEnableResult> => {
  if (d.policy.get().computer?.enabled) return { ok: false, reason: "already_on" };
  if (!(await d.osAuth.verify("Chalito: activar el control del equipo")))
    return { ok: false, reason: "os_auth_failed" };
  const copy = COMPUTER_COPY[d.locale];
  if (!(await d.prompter.first(copy.examples))) return { ok: false, reason: "cancelled" };
  if (!(await d.prompter.second(copy.risk))) return { ok: false, reason: "cancelled" };
  if ((await d.prompter.typed(copy.phrase)).trim() !== copy.phrase) return { ok: false, reason: "cancelled" };
  const cur = d.policy.get();
  await d.policy.set(
    {
      ...cur,
      computer: {
        enabled: true,
        maxActionsPerMinute: cur.computer?.maxActionsPerMinute ?? DEFAULT_COMPUTER.maxActionsPerMinute,
      },
    },
    "local",
  );
  await d.emit("computer.enabled", { copyVersion: COMPUTER_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

/** Always allowed locally, no OS prompt: turning it off can only make things safer. */
export const disableComputer = async (d: Pick<ComputerToggleDeps, "policy" | "emit">, by: string): Promise<boolean> => {
  const cur = d.policy.get();
  if (!cur.computer?.enabled) return false;
  await d.policy.set({ ...cur, computer: { ...cur.computer, enabled: false } }, "local");
  await d.emit("computer.disabled", { by });
  return true;
};
