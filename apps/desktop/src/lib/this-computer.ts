import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * "Esta computadora" (First Run C, ADR 0028): start with the computer (src-tauri/src/autostart.rs)
 * and the OS folder picker for workspaces. Both are native; adding the folder is the agent's
 * (`addWorkspace`), which asks the OS itself first.
 */
export interface ThisComputerApi {
  /** Whether Chalito starts when the person signs in to the computer. */
  autostart(): Promise<boolean>;
  /** The panel's switch; resolves to what the OS has afterwards. */
  setAutostart(enabled: boolean): Promise<boolean>;
  /** The OS folder picker: the chosen folder, or null when cancelled. */
  pickFolder(): Promise<string | null>;
}

export const tauriThisComputer: ThisComputerApi = {
  autostart: () => invoke<boolean>("autostart_status"),
  setAutostart: (enabled) => invoke<boolean>("set_autostart", { enabled }),
  pickFolder: () => invoke<string | null>("pick_folder"),
};

/** `vite dev` in a browser: no native side. */
export const browserThisComputer: ThisComputerApi = {
  autostart: async () => false,
  setAutostart: async () => Promise.reject(new Error("unavailable")),
  pickFolder: async () => null,
};

export const thisComputer = (): ThisComputerApi => (isTauri() ? tauriThisComputer : browserThisComputer);
