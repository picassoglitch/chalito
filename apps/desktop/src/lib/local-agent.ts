import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The bundled agent the app runs while it's open (src-tauri/src/agent.rs), and the `chalito`
 * command on PATH (src-tauri/src/cli_install.rs). Shapes match the Rust side's JSON.
 */
export type AgentStatus =
  | { state: "no_sidecar" }
  | { state: "not_paired" }
  | { state: "running"; pid: number }
  | { state: "restarting"; exitCode: number | null; retryInMs: number }
  | { state: "needs_setup" }
  | { state: "elsewhere" }
  | { state: "stopped" };

export type InstallError =
  "no_sidecar" | "move_to_applications" | "no_local_app_data" | "exists" | "cancelled" | "failed";

export interface CliStatus {
  os: "linux" | "macos" | "windows";
  installed: boolean;
  /** Where `chalito` is, or will be. */
  command: string | null;
  /** Whether a new terminal finds it. */
  onPath: boolean;
  /** macOS asks for an administrator password. */
  adminPrompt: boolean;
  unavailable: InstallError | null;
}

export interface LocalAgentApi {
  status(): Promise<AgentStatus>;
  cliStatus(): Promise<CliStatus>;
  /** Rejects with an InstallError. */
  installCli(): Promise<CliStatus>;
}

const INSTALL_ERRORS: InstallError[] = [
  "no_sidecar",
  "move_to_applications",
  "no_local_app_data",
  "exists",
  "cancelled",
  "failed",
];
export const installError = (e: unknown): InstallError =>
  INSTALL_ERRORS.includes(e as InstallError) ? (e as InstallError) : "failed";

export const tauriLocalAgent: LocalAgentApi = {
  status: () => invoke<AgentStatus>("agent_status"),
  cliStatus: () => invoke<CliStatus>("cli_status"),
  installCli: () => invoke<CliStatus>("install_cli"),
};

/** `vite dev` in a browser: no native side, so no agent. */
export const browserLocalAgent: LocalAgentApi = {
  status: async () => ({ state: "no_sidecar" }),
  cliStatus: async () => ({
    os: "linux",
    installed: false,
    command: null,
    onPath: false,
    adminPrompt: false,
    unavailable: "no_sidecar",
  }),
  installCli: async () => Promise.reject("no_sidecar"),
};

export const localAgent = (): LocalAgentApi => (isTauri() ? tauriLocalAgent : browserLocalAgent);
