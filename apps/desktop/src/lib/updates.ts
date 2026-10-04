/**
 * In-app updates (ADR 0014): the Tauri updater checks the api's signed-URL manifest
 * (/releases/{channel}/latest.json), downloads, verifies the minisign signature against the
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
}

export const tauriUpdater: UpdaterApi = {
  check: async () => (await import("@tauri-apps/plugin-updater")).check(),
  relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
};

export type UpdateState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "current" }
  | { step: "available"; version: string; notes: string }
  | { step: "downloading"; version: string; received: number; total: number | null }
  | { step: "ready"; version: string }
  | { step: "unavailable" }
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

  #set(s: UpdateState): void {
    this.#s = s;
    for (const l of this.#listeners) l();
  }
}
