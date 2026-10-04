import type { OsAuth } from "./devmode.js";
import type { ProcessRunner } from "./runner.js";

export const WINDOWS_UNAVAILABLE = {
  es: "En Windows, el Modo desarrollador se activa desde la app de escritorio (Windows Hello). Llega en M7.",
  en: "Developer mode on Windows is enabled from the desktop app (Windows Hello), coming in M7.",
} as const;

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** macOS: the system administrator prompt (Touch ID where available), running `true`. */
export class MacOsAuth implements OsAuth {
  constructor(private readonly runner: ProcessRunner) {}
  async verify(reason: string): Promise<boolean> {
    const script = `do shell script "true" with prompt ${appleScriptString(reason)} with administrator privileges`;
    return (await this.runner.run("osascript", ["-e", script])).code === 0;
  }
}

/** Linux: polkit via pkexec (password or fingerprint through the session's polkit agent). */
export class LinuxOsAuth implements OsAuth {
  constructor(private readonly runner: ProcessRunner) {}
  async verify(_reason: string): Promise<boolean> {
    // pkexec talks to the polkit agent on the terminal itself, so it needs it.
    return (await this.runner.run("pkexec", ["/bin/true"], { interactive: true })).code === 0;
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
): OsAuth => {
  if (platform === "darwin") return new MacOsAuth(runner);
  if (platform === "linux") return new LinuxOsAuth(runner);
  if (platform === "win32") return new WindowsOsAuth(notify, locale);
  return { verify: async () => false };
};
