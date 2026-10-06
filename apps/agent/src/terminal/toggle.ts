import type { Locale } from "@chalito/protocol";
import type { OsAuth } from "../devmode.js";
import { DEFAULT_REMOTE_TERMINAL, type Policy } from "../policy/schema.js";

/**
 * Turning remote terminal and the raw shell on or off. Like computer control (computer/toggle.ts),
 * turning either ON happens only on the device itself: the CLI in a terminal the person types in
 * (`chalito terminal enable`, `chalito terminal shell enable`) or the desktop panel through the
 * agent's local IPC. OS authentication first, then the confirmations and a typed phrase;
 * cancelling at any step changes nothing. No remote command reaches this (packages/protocol
 * command.ts); remote surfaces can only turn them off (`policy.tighten`).
 *
 * The raw shell is a separate switch with a stronger confirmation (a fourth step and a longer
 * phrase): it needs remote terminal on, and turning remote terminal on (again) always leaves the
 * raw shell off.
 */

export interface TerminalPrompter {
  /** 1: "Turn on …?" with concrete examples of what it allows. */
  first(examples: string[]): Promise<boolean>;
  /** 2: restates the risk and how to stop it. */
  second(risk: string): Promise<boolean>;
  /** 3: the person types the phrase. */
  typed(phrase: string): Promise<string>;
  /** 4 (raw shell only): the last warning. */
  final?(warning: string): Promise<boolean>;
}

/** Bumped when the copy changes; the audit records which version the person accepted. */
export const TERMINAL_COPY_VERSION = 1;

export interface TerminalCopy {
  examples: string[];
  risk: string;
  phrase: string;
  /** Raw shell only. */
  warning?: string;
}

export const TERMINAL_COPY: Record<Locale, TerminalCopy> = {
  es: {
    examples: [
      "Abrir en esta computadora la app de terminal de una IA (por ejemplo aider u opencode) en una carpeta permitida",
      "Ver lo que esa app muestra y escribir en ella desde tu navegador de confianza",
      "Lo que esa app haga en la carpeta (leer, editar, ejecutar) lo hace con tu usuario",
    ],
    risk: "Cada terminal pedirá tu aprobación con passkey en un dispositivo de confianza. Mientras haya una abierta verás un aviso en pantalla; la cierras con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
    phrase: "TERMINAL REMOTA",
  },
  en: {
    examples: [
      "Open an AI's terminal app (for example aider or opencode) on this computer, in an allowed folder",
      "See what that app shows and type into it from your trusted browser",
      "Whatever that app does in the folder (read, edit, run) it does as your user",
    ],
    risk: "Every terminal will ask for your passkey approval on a trusted device. While one is open you'll see a notice on screen; close it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
    phrase: "REMOTE TERMINAL",
  },
};

export const RAW_SHELL_COPY: Record<Locale, TerminalCopy> = {
  es: {
    examples: [
      "Abrir una shell completa de esta computadora (tu usuario) desde tu navegador de confianza",
      "Ejecutar cualquier comando, leer y borrar cualquier archivo al que tu usuario tenga acceso",
      "Instalar programas, cambiar configuraciones y usar las credenciales guardadas en esta cuenta",
    ],
    risk: "Es lo mismo que sentarte frente a este teclado. Cada shell pedirá tu aprobación con passkey; mientras haya una abierta verás el aviso en pantalla y la cierras con Ctrl+Alt+Esc.",
    phrase: "SHELL COMPLETA DE MI EQUIPO",
    warning:
      "Último paso: cualquiera que apruebe con tu passkey tendrá control total de tu usuario en esta computadora. Actívalo solo si lo necesitas y apágalo al terminar.",
  },
  en: {
    examples: [
      "Open a full shell on this computer (your user) from your trusted browser",
      "Run any command, read and delete any file your user can access",
      "Install programs, change settings and use the credentials stored in this account",
    ],
    risk: "It's the same as sitting at this keyboard. Every shell will ask for your passkey approval; while one is open you'll see the notice on screen and you close it with Ctrl+Alt+Esc.",
    phrase: "FULL SHELL ON MY COMPUTER",
    warning:
      "Last step: anyone who approves with your passkey gets full control of your user on this computer. Turn it on only when you need it and off when you're done.",
  },
};

export interface TerminalToggleDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  prompter: TerminalPrompter;
  locale: Locale;
  /** Audit sink; the daemon also reports `terminal.changed` on the policy change. */
  emit: (type: string, meta: Record<string, unknown>) => Promise<void> | void;
}

export type TerminalEnableResult =
  { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" | "terminal_off" };

const answers = async (d: TerminalToggleDeps, copy: TerminalCopy): Promise<boolean> => {
  if (!(await d.prompter.first(copy.examples))) return false;
  if (!(await d.prompter.second(copy.risk))) return false;
  if ((await d.prompter.typed(copy.phrase)).trim() !== copy.phrase) return false;
  if (copy.warning !== undefined && !(await d.prompter.final?.(copy.warning))) return false;
  return true;
};

export const enableRemoteTerminal = async (d: TerminalToggleDeps): Promise<TerminalEnableResult> => {
  if (d.policy.get().remoteTerminal?.enabled) return { ok: false, reason: "already_on" };
  const copy = TERMINAL_COPY[d.locale];
  if (!(await d.osAuth.verify("Chalito: activar la terminal remota"))) return { ok: false, reason: "os_auth_failed" };
  if (!(await answers(d, copy))) return { ok: false, reason: "cancelled" };
  const cur = d.policy.get();
  const prev = cur.remoteTerminal;
  await d.policy.set(
    {
      ...cur,
      remoteTerminal: {
        enabled: true,
        // Never carried over: the raw shell has its own confirmation.
        rawShell: false,
        maxSessions: prev?.maxSessions ?? DEFAULT_REMOTE_TERMINAL.maxSessions,
        maxInputPerMinute: prev?.maxInputPerMinute ?? DEFAULT_REMOTE_TERMINAL.maxInputPerMinute,
      },
    },
    "local",
  );
  await d.emit("terminal.enabled", { copyVersion: TERMINAL_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

export const enableRawShell = async (d: TerminalToggleDeps): Promise<TerminalEnableResult> => {
  const rt = d.policy.get().remoteTerminal;
  if (!rt?.enabled) return { ok: false, reason: "terminal_off" };
  if (rt.rawShell) return { ok: false, reason: "already_on" };
  const copy = RAW_SHELL_COPY[d.locale];
  if (!(await d.osAuth.verify("Chalito: activar la shell completa remota")))
    return { ok: false, reason: "os_auth_failed" };
  if (!(await answers(d, copy))) return { ok: false, reason: "cancelled" };
  const cur = d.policy.get();
  if (!cur.remoteTerminal?.enabled) return { ok: false, reason: "terminal_off" };
  await d.policy.set({ ...cur, remoteTerminal: { ...cur.remoteTerminal, rawShell: true } }, "local");
  await d.emit("terminal.raw_shell_enabled", { copyVersion: TERMINAL_COPY_VERSION, locale: d.locale });
  return { ok: true };
};

/** Always allowed locally, no OS prompt: turning it off can only make things safer. Also turns the raw shell off. */
export const disableRemoteTerminal = async (
  d: Pick<TerminalToggleDeps, "policy" | "emit">,
  by: string,
): Promise<boolean> => {
  const cur = d.policy.get();
  if (!cur.remoteTerminal?.enabled && !cur.remoteTerminal?.rawShell) return false;
  await d.policy.set({ ...cur, remoteTerminal: { ...cur.remoteTerminal, enabled: false, rawShell: false } }, "local");
  await d.emit("terminal.disabled", { by });
  return true;
};

export const disableRawShell = async (d: Pick<TerminalToggleDeps, "policy" | "emit">, by: string): Promise<boolean> => {
  const cur = d.policy.get();
  if (!cur.remoteTerminal?.rawShell) return false;
  await d.policy.set({ ...cur, remoteTerminal: { ...cur.remoteTerminal, rawShell: false } }, "local");
  await d.emit("terminal.raw_shell_disabled", { by });
  return true;
};
