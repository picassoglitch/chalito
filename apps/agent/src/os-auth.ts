import { statSync } from "node:fs";
import type { OsAuth } from "./devmode.js";
import type { ProcessRunner } from "./runner.js";

export const WINDOWS_UNAVAILABLE = {
  es: "En Windows, el Modo desarrollador se activa desde la app de escritorio (Windows Hello). Llega en M7.",
  en: "Developer mode on Windows is enabled from the desktop app (Windows Hello), coming in M7.",
} as const;

export const PKEXEC = "/usr/bin/pkexec";
export const OSASCRIPT = "/usr/bin/osascript";

export type StatFn = (path: string) => { uid: number; mode: number; isFile(): boolean };

/**
 * An OS-auth helper is only trusted when it's a root-owned file that neither group nor
 * others can write. A same-named file earlier in PATH (~/.local/bin/pkexec) is never used:
 * helpers are called by absolute path.
 */
export const trustedHelper = (path: string, stat: StatFn = statSync): boolean => {
  try {
    const st = stat(path);
    return st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
};

const UNTRUSTED = {
  es: (p: string) => `${p} no existe o no es de root (o se puede escribir): no se puede verificar tu identidad.`,
  en: (p: string) => `${p} is missing, not owned by root, or writable by others: can't verify your identity.`,
} as const;

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** macOS: the system administrator prompt (Touch ID where available), running `true`. */
export class MacOsAuth implements OsAuth {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly notify: (m: string) => void = () => undefined,
    private readonly stat?: StatFn,
    private readonly locale: "es" | "en" = "es",
  ) {}
  async verify(reason: string): Promise<boolean> {
    if (!trustedHelper(OSASCRIPT, this.stat)) return (this.notify(UNTRUSTED[this.locale](OSASCRIPT)), false);
    const script = `do shell script "true" with prompt ${appleScriptString(reason)} with administrator privileges`;
    return (await this.runner.run(OSASCRIPT, ["-e", script])).code === 0;
  }
}

/** Linux: polkit via pkexec (password or fingerprint through the session's polkit agent). */
export class LinuxOsAuth implements OsAuth {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly notify: (m: string) => void = () => undefined,
    private readonly stat?: StatFn,
    private readonly locale: "es" | "en" = "es",
  ) {}
  async verify(_reason: string): Promise<boolean> {
    if (!trustedHelper(PKEXEC, this.stat)) return (this.notify(UNTRUSTED[this.locale](PKEXEC)), false);
    // pkexec talks to the polkit agent on the terminal itself, so it needs it.
    return (await this.runner.run(PKEXEC, ["/bin/true"], { interactive: true })).code === 0;
  }
}

/** Windows: not from the CLI. Always refuses, with a message saying where to do it. */
export class WindowsOsAuth implements OsAuth {
  constructor(
    private readonly notify: (message: string) => void,
    private readonly locale: "es" | "en" = "es",
  ) {}
  async verify(): Promise<boolean> {
    this.notify(WINDOWS_UNAVAILABLE[this.locale]);
    return false;
  }
}

export const osAuthFor = (
  platform: NodeJS.Platform,
  runner: ProcessRunner,
  notify: (message: string) => void,
  locale: "es" | "en" = "es",
  stat?: StatFn,
): OsAuth => {
  if (platform === "darwin") return new MacOsAuth(runner, notify, stat, locale);
  if (platform === "linux") return new LinuxOsAuth(runner, notify, stat, locale);
  if (platform === "win32") return new WindowsOsAuth(notify, locale);
  return { verify: async () => false };
};
