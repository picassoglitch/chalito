import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import type { AppConnectionDoc, DevModeToggle, Recipe, RecipeInstall } from "@chalito/protocol";

/**
 * Local-only surfaces, reached through the agent's IPC (ADR 0004: the agent is a user
 * service; the desktop app talks to it on this machine). They are local on purpose: a
 * remote surface (PWA, phone) can never enable Developer mode or confirm a pairing for this
 * computer. The agent serves them on a per-user local socket (apps/agent/src/ipc-server.ts),
 * reached through the native side's `agent_ipc` command with the per-launch secret the app gave
 * the agent it started (src-tauri/src/ipc_client.rs). Outside Tauri, `unavailableIpc`.
 *
 * Shapes follow the agent: `runPair`'s reverse fingerprint check (apps/agent/src/pair.ts)
 * and `DevMode.enableToggle`'s three confirmations (apps/agent/src/devmode.ts), with the
 * panel rendering what the CLI renders on a TTY today.
 */

/** The phone that claimed this computer, waiting for the local reverse check. */
export interface PendingPairing {
  pairingId: string;
  /** Name the phone gave itself ("Pixel 9"). */
  label: string;
  /** The phone's key fingerprint; the phone shows the same string. */
  fingerprint: string;
  /** Short passkey id when the phone enrolled one (`shortPasskeyId`). */
  passkeyId: string | null;
  expiresAt: number;
}

export interface PolicyView {
  /** policy.lock sequence and hash-chain head. */
  seq: number;
  hash: string;
  prevHash: string | null;
  updatedAt: number;
  /** Rules as the agent renders them (human-readable, already localized). */
  rules: { id: string; summary: string; effect: "allow" | "ask" | "deny" }[];
}

export interface DevModeState {
  on: boolean;
  toggles: DevModeToggle[];
  since: number | null;
}

/** What the agent asks before enabling one toggle (its RISK_COPY + the liability text). */
export interface DevModeChallenge {
  toggle: DevModeToggle;
  examples: string[];
  risk: string;
  liability: { version: number; phrase: string; text: string };
}

/** The user's answers to the three confirmations, in order. */
export interface DevModeAnswers {
  first: boolean;
  second: boolean;
  liability: { checked: boolean; typed: string };
}

export type EnableResult =
  { ok: true; state: DevModeState } | { ok: false; reason: "os_auth_failed" | "cancelled" | "unavailable" };

/** One app as the agent sees it on this computer (apps/agent/src/apps/manager.ts `AppView`). */
export interface AppView {
  appId: string;
  recipe: Recipe;
  /** The person's own recipe ("Personalizada"), from ~/.chalito/recipes. */
  custom: boolean;
  /** Curated: always. Custom: enabled on this computer and unchanged since. */
  enabled: boolean;
  /** The same status doc the agent reports to chalito.connections. */
  doc: AppConnectionDoc;
  /** The recipe (and providers.yaml, for the former providers) allow the app's own sign-in. */
  signinAllowed: boolean;
  /** A remote install (from the phone or the web) waiting for a yes here, until this time. */
  installRequestedUntil: number | null;
  /** This OS has an entry in the recipe (web apps: always). */
  supported: boolean;
  /** The official install for this OS, if any. */
  install: RecipeInstall | null;
}

/** A custom recipe file that didn't load (local only). */
export interface CustomProblem {
  file: string;
  reason: "invalid" | "shadows_curated" | "duplicate_id" | "too_large";
}

export interface AppsView {
  apps: AppView[];
  problems: CustomProblem[];
  catalog: { source: "builtin" | "remote"; issuedAt: number } | null;
}

/** What the agent shows before enabling a custom recipe: every command it runs. */
export interface CustomChallenge {
  title: string;
  warn: string;
  type: string;
  summary: string[];
}

export type CustomEnableResult =
  { ok: true } | { ok: false; reason: "unknown_recipe" | "already_on" | "os_auth_failed" | "cancelled" };

/** Computer control as the agent reports it (apps/agent/src/computer/control.ts `status`). */
export interface ComputerStatus {
  enabled: boolean;
  active: { sid: string; label: string; since: number }[];
  pending: { sid: string; label: string }[];
}

/** What the agent asks before turning computer control on (computer/toggle.ts `COMPUTER_COPY`). */
export interface ComputerChallenge {
  examples: string[];
  risk: string;
  phrase: string;
}

export interface ComputerAnswers {
  first: boolean;
  second: boolean;
  typed: string;
}

export type ComputerEnableResult =
  { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" | "unavailable" };

/** macOS privacy permissions as the app has them (src-tauri/src/computer.rs); null elsewhere. */
export interface ComputerPermissions {
  platform: "macos" | "windows" | "linux";
  screenRecording: boolean | null;
  accessibility: boolean | null;
  wayland: boolean;
}

/** Remote terminal as the agent reports it (apps/agent/src/terminal/control.ts `status`). */
export interface TerminalStatus {
  enabled: boolean;
  rawShell: boolean;
  active: { sid: string; label: string; since: number }[];
  pending: { sid: string; label: string }[];
}

/** What the agent asks before turning remote terminal / the raw shell on (terminal/toggle.ts). */
export interface TerminalCopy {
  examples: string[];
  risk: string;
  phrase: string;
  /** The raw shell's fourth step. */
  warning?: string;
}

export interface TerminalChallenge {
  terminal: TerminalCopy;
  rawShell: TerminalCopy;
}

export interface TerminalAnswers {
  first: boolean;
  second: boolean;
  typed: string;
  final?: boolean;
}

export type TerminalEnableResult =
  { ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" | "already_on" | "terminal_off" | "unavailable" };

/** Remote screen as the agent reports it (apps/agent/src/screen/manager.ts `status`). */
export interface ScreenStatus {
  view: boolean;
  control: boolean;
  active: { sid: string; label: string; mode: "view" | "control"; since: number }[];
  pending: { sid: string; label: string; mode: "view" | "control" }[];
}

export type ScreenMode = "view" | "control";

export interface AgentIpc {
  /** Whether the local agent answered (installed, running, same OS user). */
  ping(): Promise<{ version: string }>;
  pendingPairing(): Promise<PendingPairing | null>;
  /** The local verdict on the reverse check; `match: false` aborts the pairing. */
  confirmPairing(pairingId: string, match: boolean): Promise<void>;
  policy(): Promise<PolicyView>;
  devMode(): Promise<DevModeState>;
  devModeChallenge(toggle: DevModeToggle): Promise<DevModeChallenge>;
  /** The agent re-asks the OS (password / biometric) and re-checks the answers itself. */
  enableDevToggle(toggle: DevModeToggle, answers: DevModeAnswers): Promise<EnableResult>;
  disableDevToggle(toggle: DevModeToggle): Promise<DevModeState>;
  /** Presence goes through the agent: RLS lets only the agent device update its own row. */
  reportPresence(p: { desktopActive: boolean }): Promise<void>;
  /** "IA conectadas": every app this computer knows (curated and the person's own) and its state. */
  apps(): Promise<AppsView>;
  /** Saves the key in this computer's keychain (it goes over the local socket only). */
  connectAppKey(appId: string, key: string): Promise<void>;
  /**
   * Starts the app's own sign-in here (its CLI login opens the browser; a desktop or web app just
   * opens, and the person signs in there). Rejects with `blocked_by_policy`.
   */
  signinApp(appId: string): Promise<void>;
  disconnectApp(appId: string): Promise<void>;
  /** The person's local yes: the app's official install (or its official download page). */
  installApp(appId: string): Promise<void>;
  /** The person's no to a remote install request. */
  declineAppInstall(appId: string): Promise<void>;
  /** Opens the app on this computer. */
  launchApp(appId: string): Promise<void>;
  /** Custom recipes: what enabling one runs, then the local enable (the agent asks the OS itself). */
  customRecipeChallenge(appId: string): Promise<CustomChallenge>;
  enableCustomRecipe(appId: string, answers: { review: boolean; typed: string }): Promise<CustomEnableResult>;
  disableCustomRecipe(appId: string): Promise<void>;
  /**
   * Computer control. Reading the state here doesn't count as the indicator's heartbeat (the
   * native side sends that); enabling asks the OS in the agent and re-checks the answers.
   */
  computerStatus(): Promise<ComputerStatus>;
  computerChallenge(): Promise<ComputerChallenge>;
  enableComputer(answers: ComputerAnswers): Promise<ComputerEnableResult>;
  disableComputer(): Promise<void>;
  /** The panel's kill switch (through the native side, like the hotkey and the tray item). */
  stopComputer(): Promise<void>;
  /** Native, not the agent: macOS Screen Recording / Accessibility, Wayland on Linux. */
  computerPermissions(): Promise<ComputerPermissions>;
  openComputerSettings(pane: "screenRecording" | "accessibility"): Promise<void>;
  /**
   * Remote terminal. Enabling asks the OS in the agent and re-checks the answers; the raw shell
   * has its own, stronger confirmation. Open terminals stop with the computer-control kill switch.
   */
  terminalStatus(): Promise<TerminalStatus>;
  terminalChallenge(): Promise<TerminalChallenge>;
  enableRemoteTerminal(answers: TerminalAnswers): Promise<TerminalEnableResult>;
  enableRawShell(answers: TerminalAnswers): Promise<TerminalEnableResult>;
  disableRemoteTerminal(): Promise<void>;
  disableRawShell(): Promise<void>;
  /** Remote screen: enabling asks the OS in the agent and re-checks the answers, like computer control. */
  screenStatus(): Promise<ScreenStatus>;
  screenChallenge(mode: ScreenMode): Promise<ComputerChallenge>;
  enableScreen(mode: ScreenMode, answers: ComputerAnswers): Promise<ComputerEnableResult>;
  /** `control` drops back to view only; `all` turns remote screen off. */
  disableScreen(what: "control" | "all"): Promise<void>;
  closeScreen(sid: string): Promise<void>;
}

export class IpcUnavailableError extends Error {
  constructor() {
    super("agent_ipc_unavailable");
    this.name = "IpcUnavailableError";
  }
}

const unavailable = () => Promise.reject(new IpcUnavailableError());

/** Until the agent's IPC server exists: every call fails with IpcUnavailableError. */
export const unavailableIpc: AgentIpc = {
  ping: unavailable,
  pendingPairing: unavailable,
  confirmPairing: unavailable,
  policy: unavailable,
  devMode: unavailable,
  devModeChallenge: unavailable,
  enableDevToggle: unavailable,
  disableDevToggle: unavailable,
  reportPresence: unavailable,
  apps: unavailable,
  connectAppKey: unavailable,
  signinApp: unavailable,
  disconnectApp: unavailable,
  installApp: unavailable,
  declineAppInstall: unavailable,
  launchApp: unavailable,
  customRecipeChallenge: unavailable,
  enableCustomRecipe: unavailable,
  disableCustomRecipe: unavailable,
  computerStatus: unavailable,
  computerChallenge: unavailable,
  enableComputer: unavailable,
  disableComputer: unavailable,
  stopComputer: unavailable,
  computerPermissions: unavailable,
  openComputerSettings: unavailable,
  terminalStatus: unavailable,
  terminalChallenge: unavailable,
  enableRemoteTerminal: unavailable,
  enableRawShell: unavailable,
  disableRemoteTerminal: unavailable,
  disableRawShell: unavailable,
  screenStatus: unavailable,
  screenChallenge: unavailable,
  enableScreen: unavailable,
  disableScreen: unavailable,
  closeScreen: unavailable,
};

/** Mirrors the agent's check, so the button stays disabled until all three are given. */
export const answersComplete = (a: DevModeAnswers, phrase: string): boolean =>
  a.first && a.second && a.liability.checked && a.liability.typed.trim() === phrase;

/** What `agent_ipc` rejects with when no agent this app started is answering. */
export const IPC_UNAVAILABLE = "agent_ipc_unavailable";

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

/** The real agent, through the native side. Error codes come back as Error messages. */
export const invokeIpc = (invoke: Invoke = tauriInvoke): AgentIpc => {
  const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>("agent_ipc", { method, params: params ?? null });
    } catch (e) {
      const code = typeof e === "string" ? e : e instanceof Error ? e.message : "internal";
      throw code === IPC_UNAVAILABLE ? new IpcUnavailableError() : new Error(code);
    }
  };
  return {
    ping: () => call("ping"),
    pendingPairing: () => call("pendingPairing"),
    confirmPairing: (pairingId, match) => call("confirmPairing", { pairingId, match }),
    policy: () => call("policy"),
    devMode: () => call("devMode"),
    devModeChallenge: (toggle) => call("devModeChallenge", { toggle }),
    enableDevToggle: (toggle, answers) => call("enableDevToggle", { toggle, answers }),
    disableDevToggle: (toggle) => call("disableDevToggle", { toggle }),
    reportPresence: (p) => call("reportPresence", { desktopActive: p.desktopActive }),
    apps: () => call("apps"),
    connectAppKey: async (appId, key) => void (await call("connectAppKey", { appId, key })),
    signinApp: async (appId) => void (await call("signinApp", { appId })),
    disconnectApp: async (appId) => void (await call("disconnectApp", { appId })),
    installApp: async (appId) => void (await call("installApp", { appId })),
    declineAppInstall: async (appId) => void (await call("declineAppInstall", { appId })),
    launchApp: async (appId) => void (await call("launchApp", { appId })),
    customRecipeChallenge: (appId) => call("customRecipeChallenge", { appId }),
    enableCustomRecipe: (appId, answers) => call("enableCustomRecipe", { appId, answers }),
    disableCustomRecipe: async (appId) => void (await call("disableCustomRecipe", { appId })),
    // No `indicatorShown`: only the native poller's report counts as the indicator's heartbeat.
    computerStatus: () => call("computerStatus"),
    computerChallenge: () => call("computerChallenge"),
    enableComputer: (answers) => call("enableComputer", { answers }),
    disableComputer: () => call("disableComputer"),
    stopComputer: () => invoke("computer_stop", {}),
    computerPermissions: () => invoke("computer_permissions", {}),
    openComputerSettings: (pane) => invoke("computer_open_settings", { pane }),
    terminalStatus: () => call("terminalStatus"),
    terminalChallenge: () => call("terminalChallenge"),
    enableRemoteTerminal: (answers) => call("enableRemoteTerminal", { answers }),
    enableRawShell: (answers) => call("enableRawShell", { answers }),
    disableRemoteTerminal: async () => void (await call("disableRemoteTerminal")),
    disableRawShell: async () => void (await call("disableRawShell")),
    screenStatus: () => call("screenStatus"),
    screenChallenge: (mode) => call("screenChallenge", { mode }),
    enableScreen: (mode, answers) => call("enableScreen", { mode, answers }),
    disableScreen: async (what) => void (await call("disableScreen", { what })),
    closeScreen: async (sid) => void (await call("closeScreen", { sid })),
  };
};

export const agentIpc = (): AgentIpc => (isTauri() ? invokeIpc() : unavailableIpc);
