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
  /** This system's glibc version, or null off glibc (Windows, macOS, musl). */
  libcVersion?(): Promise<string | null>;
}

/** The Linux release builds on Ubuntu 24.04, so it needs glibc 2.39. The .deb's libc6 floor must match
 * (release-workflow.test.ts). Older systems keep the version they have instead of one that won't start. */
export const MIN_GLIBC = "2.39";

/** True when `version` ("2.35") is at least `min`; an unreadable version passes, as off glibc. */
export const glibcAtLeast = (version: string | null, min = MIN_GLIBC): boolean => {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [a, b] = [parse(version ?? ""), parse(min)];
  if (!version || a.some(Number.isNaN)) return true;
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

export const tauriUpdater: UpdaterApi = {
  check: async () => (await import("@tauri-apps/plugin-updater")).check(),
  relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
  libcVersion: async () => (await import("@tauri-apps/api/core")).invoke<string | null>("libc_version"),
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
      if (u && !(await this.#libcOk())) return this.#set({ step: "tooOld", version: u.version, needs: MIN_GLIBC });
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
    if (!(await this.#libcOk())) return this.#set({ step: "tooOld", version: u.version, needs: MIN_GLIBC });
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

  async #libcOk(): Promise<boolean> {
    return glibcAtLeast((await this.api.libcVersion?.().catch(() => null)) ?? null);
  }

  #set(s: UpdateState): void {
    this.#s = s;
    for (const l of this.#listeners) l();
  }
}
