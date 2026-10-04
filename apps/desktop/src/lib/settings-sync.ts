import { SettingsError, type SettingsStore } from "@chalito/client/settings";
import type { SettingsValues } from "@chalito/ui";
import { loadSettings, saveSettings } from "./settings-local.js";

export type SaveError = "rejected" | "failed" | null;
export interface SettingsView {
  values: SettingsValues | null;
  error: SaveError;
  persisted: "server" | "device";
}

type Server = Pick<SettingsStore, "load" | "save" | "saveCompanion">;

/**
 * The panel's settings, framework-free (the PWA's useSettings, for the desktop): server-backed
 * (get/update_my_settings via @chalito/client's SettingsStore) once signed in, else this
 * device. Changes apply optimistically, then the server's view is re-read, so a refused
 * change (calls without a verified phone) snaps back with `rejected`. Companion edits are
 * debounced (no RPC per keystroke). An unreachable server falls back to the device copy.
 */
export class DesktopSettings {
  #view: SettingsView = { values: null, error: null, persisted: "device" };
  #server: Server | null;
  #companionTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    server: Server | null,
    private readonly local: { load: () => SettingsValues; save: (v: SettingsValues) => void } = {
      load: () => loadSettings(),
      save: (v) => saveSettings(v),
    },
    private readonly companionDebounceMs = 500,
  ) {
    this.#server = server;
  }

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): SettingsView => this.#view;

  async start(): Promise<void> {
    if (!this.#server) return this.#set({ values: this.local.load(), persisted: "device" });
    try {
      await this.#reload();
    } catch {
      this.#server = null;
      this.#set({ values: this.local.load(), error: "failed", persisted: "device" });
    }
  }

  set<K extends keyof SettingsValues>(k: K, v: SettingsValues[K]): void {
    const cur = this.#view.values;
    if (!cur) return;
    const next = { ...cur, [k]: v };
    this.#set({ values: next, error: null });
    const server = this.#server;
    if (!server) return this.local.save(next);
    if (k === "avatar" || k === "companionName") {
      if (this.#companionTimer) clearTimeout(this.#companionTimer);
      this.#companionTimer = setTimeout(() => {
        this.#companionTimer = null;
        const latest = this.#view.values;
        if (latest) void server.saveCompanion(latest).catch(() => this.#set({ error: "failed" }));
      }, this.companionDebounceMs);
      return;
    }
    void server
      .save(k, v)
      .catch((err: unknown) =>
        this.#set({ error: err instanceof SettingsError && err.code === "rejected" ? "rejected" : "failed" }),
      )
      .finally(() => void this.#reload().catch(() => undefined));
  }

  dispose(): void {
    if (this.#companionTimer) clearTimeout(this.#companionTimer);
    this.#listeners.clear();
  }

  async #reload(): Promise<void> {
    const r = await this.#server!.load();
    this.#set({ values: r.values, persisted: "server" });
  }

  #set(p: Partial<SettingsView>): void {
    this.#view = { ...this.#view, ...p };
    for (const l of this.#listeners) l();
  }
}
