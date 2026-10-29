/**
 * In-app updates (ADR 0014): the Tauri updater checks the api's signed-URL manifest
 * (/releases/{channel}/latest-v2.json), downloads, verifies the minisign signature against the
 * public key baked into the build (mandatory, can't be disabled) and installs; then relaunch.
 * Only release builds carry an updater: elsewhere `check` fails and the screen says so.
 */
export interface FoundUpdate {
  version: string;
  body?: string;
  downloadAndInstall(
    onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ): Promise<void>;
  close?(): Promise<void>;
}

export interface UpdaterApi {
  check(): Promise<FoundUpdate | null>;
  relaunch(): Promise<void>;
  /** This system's glibc version, or null off glibc (Windows, macOS). */
  libcVersion?(): Promise<string | null>;
  /** True on Linux, where every build is glibc: there, not knowing the version blocks the update. */
  onLinux?: boolean;
}

/** The glibc the Linux builds this one may be offered need: from 0.1.0-beta.14 they build on Ubuntu
 * 24.04 (2.39). Older systems keep the version they have instead of one that won't start. */
export const MIN_GLIBC = "2.39";

/** "2.39" as [2, 39], or null when it isn't a version. */
const parseVersion = (v: string): number[] | null => {
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  return parts.some(Number.isNaN) ? null : parts;
};

/** True when `version` ("2.35") is at least `min`. */
export const glibcAtLeast = (version: string, min = MIN_GLIBC): boolean => {
  const [a, b] = [parseVersion(version) ?? [0], parseVersion(min) ?? [0]];
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Whether this system may install a build that needs MIN_GLIBC. Fails closed on Linux: a build
 * that can't start is worse than staying on this one. Off Linux there is no glibc to check. */
export const libcGate = async (api: UpdaterApi): Promise<"ok" | "tooOld" | "unknown"> => {
  if (!api.libcVersion) return api.onLinux ? "unknown" : "ok";
  const v = await api.libcVersion().catch(() => null);
  if (v === null || parseVersion(v) === null) return api.onLinux ? "unknown" : "ok";
  return glibcAtLeast(v) ? "ok" : "tooOld";
};

export const tauriUpdater: UpdaterApi = {
  check: async () => (await import("@tauri-apps/plugin-updater")).check(),
  relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
  libcVersion: async () => (await import("@tauri-apps/api/core")).invoke<string | null>("libc_version"),
  onLinux:
    typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent),
};

export type UpdateState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "current" }
  | { step: "available"; version: string; notes: string }
  | { step: "downloading"; version: string; received: number; total: number | null }
  | { step: "ready"; version: string }
  | { step: "unavailable" }
  | { step: "tooOld"; version: string; needs: string }
  | { step: "libcUnknown"; version: string }
  | { step: "error" };

export class UpdateController {
  #s: UpdateState = { step: "idle" };
  #found: FoundUpdate | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly api: UpdaterApi) {}

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): UpdateState => this.#s;

  async check(): Promise<void> {
    if (this.#s.step === "checking" || this.#s.step === "downloading") return;
    this.#set({ step: "checking" });
    try {
      const u = await this.api.check();
      await this.#found?.close?.().catch(() => undefined);
      this.#found = u;
      if (u && (await this.#blocked(u.version))) return;
      this.#set(u ? { step: "available", version: u.version, notes: u.body ?? "" } : { step: "current" });
    } catch (err) {
      // No updater in this build (dev / plain debug) vs. a real failure (offline, bad manifest).
      this.#set(
        /not.*(allowed|found|registered)|plugin/i.test(String(err)) ? { step: "unavailable" } : { step: "error" },
      );
    }
  }

  async install(): Promise<void> {
    const u = this.#found;
    if (!u || this.#s.step !== "available") return;
    if (await this.#blocked(u.version)) return;
    let received = 0;
    let total: number | null = null;
    this.#set({ step: "downloading", version: u.version, received, total });
    try {
      // A bad signature makes this throw: nothing is installed.
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data?.contentLength ?? null;
        if (e.event === "Progress") received += e.data?.chunkLength ?? 0;
        this.#set({ step: "downloading", version: u.version, received, total });
      });
      this.#set({ step: "ready", version: u.version });
    } catch {
      this.#set({ step: "error" });
    }
  }

  relaunch(): Promise<void> {
    return this.api.relaunch();
  }

  /** Sets the reason and returns true when this system can't take `version` (libcGate). */
  async #blocked(version: string): Promise<boolean> {
    const g = await libcGate(this.api);
    if (g === "tooOld") this.#set({ step: "tooOld", version, needs: MIN_GLIBC });
    if (g === "unknown") this.#set({ step: "libcUnknown", version });
    return g !== "ok";
  }

  #set(s: UpdateState): void {
    this.#s = s;
    for (const l of this.#listeners) l();
  }
}
