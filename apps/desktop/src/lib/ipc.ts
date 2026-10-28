import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import type { AgentLink, AppConnectionDoc, DevModeToggle, LinkMode, Recipe, RecipeInstall } from "@chalito/protocol";
import type { PrWatchSettings, PrWatchView } from "./prs.js";

// Local-only surfaces over the agent's per-user socket (ADR 0004, ipc-server.ts, src-tauri ipc_client.rs):
// a remote surface can never enable Developer mode or confirm a pairing. Outside Tauri, `unavailableIpc`.

/** Where pairing from the panel is (apps/agent/src/pairing-host.ts `PairingView`). */
export type PairingPhase =
  | "starting"
  | "waiting"
  | "claimed"
  | "replace"
  | "paired"
  | "expired"
  | "declined"
  | "cancelled"
  | "rejected"
  | "failed";

export interface PendingPairing {
  pairingId: string;
  state: PairingPhase;
  /** This computer, as the approval screen shows it; null until the api answered. */
  computer: {
    shortCode: string;
    /** This computer's verification code (key fingerprint). */
    fingerprint: string;
    label: string;
    /** `…/computadoras/aprobar#c=<codeId>`: the code id only, never the short code. */
    approveUrl: string;
    expiresAt: number;
    /** The pairing glyph, for a phone's camera on the approval screen. */
    glyph: unknown;
  } | null;
  /** The device that approved, for the reverse check. */
  claimer: { fingerprint: string; passkeyId: string | null } | null;
  /** In `replace`: what to type before this computer changes account. */
  replacePhrase: string | null;
  error: string | null;
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
  /** Sessions allowed on this computer (off until allowed here, owner 2026-10-06); null = policy.adapters decides. */
  sessions: boolean | null;
  /** Apps with a CLI here: whether Chalito trusts it (apps/agent/src/apps/manager.ts AppPinView). */
  pin?: AppPinView | null;
}

/** `pinned` runs; `not_pinned` awaits "Usar"; `changed` updated itself; `missing` is gone; `unsafe` is
 * writable by anyone. */
export interface AppPinView {
  state: "pinned" | "not_pinned" | "changed" | "missing" | "unsafe";
  path: string | null;
  /** What "Usar" would trust now, or null. */
  detected: string | null;
  /** The sha256 of `detected` as shown; "Usar" / "confirmar" send it back and the agent re-checks it. */
  sha256: string | null;
}

/** A folder Chalito may work in (the signed policy's workspaces). */
export interface Workspace {
  label: string;
  path: string;
}

export type AddWorkspaceResult =
  | { ok: true; label: string; added: boolean }
  | {
      ok: false;
      reason:
        | "not_a_folder"
        | "too_broad"
        | "chalito_folder"
        | "sensitive"
        | "startup"
        | "ai_config"
        | "os_auth_failed"
        | "too_many";
    };

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

export type SessionsEnableResult =
  | { ok: true }
  | { ok: false; reason: "unknown_recipe" | "not_applicable" | "already_on" | "os_auth_failed" | "cancelled" };

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

/** Coordinator mode (apps/agent/src/coord/toggle.ts): what Chalito answers for the owner here. */
export interface CoordinatorStatus {
  /** Empty while off. */
  kinds: string[];
}
/** What the agent shows before turning it on (`COORDINATOR_COPY`). */
export interface CoordinatorChallenge {
  answers: string[];
  asks: string[];
}
export type CoordinatorEnableResult =
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

/** A link as the panel sends it: the agent sets `v`, `createdAt` and `createdBy: "local"`. */
export type LinkSpec = Omit<AgentLink, "v" | "createdAt" | "createdBy">;

/** This computer's public keys, for a link's own end (apps/agent/src/ipc-handlers.ts `linkList`). */
export interface LinkIdentity {
  deviceId: string;
  pubSign: string;
  pubBox: string;
}

/** Active links on this computer; `pendingPublish` ids carry nothing until the cloud mirror has them. */
export interface LinksView {
  links: AgentLink[];
  pendingPublish: string[];
  self: LinkIdentity | null;
}

/** What the agent restates before making a link (links/local.ts `LINK_COPY`). */
export interface LinkChallenge {
  mode: LinkMode;
  summary: string[];
  phrase: string;
}

export type LinkAddResult = { ok: true; link: AgentLink } | { ok: false; reason: string };

/** A session the person started outside Chalito, as the agent derives it (apps/agent/src/watch). */
export interface OwnSessionView {
  key: string;
  source: "claude" | "codex";
  id: string;
  cwd: string | null;
  title: string | null;
  state: "working" | "question" | "approval" | "error" | "finished" | "closed";
  since: number;
  detail: string | null;
  /** A generic line the panel words itself; `detail` is then only its argument (a tool, a reason). */
  detailKey: "question" | "approval" | "stopped" | "tool" | "apiError" | null;
  level: "L1" | "L2" | "L3" | null;
  reviewing: boolean;
  guessed: boolean;
  seen: boolean;
}

export type OwnOpenResult = ({ opened: true; via: "terminal" | "codex" } | { opened: false }) & {
  id: string;
  cwd: string | null;
};

export interface AgentIpc {
  /** Whether the local agent answered (installed, running, same OS user). */
  ping(): Promise<{ version: string }>;
  /** "Conectar esta computadora": starts pairing (or returns the one in progress). Unpaired agents only. */
  startPairing(kind?: "desktop" | "laptop"): Promise<PendingPairing>;
  pendingPairing(): Promise<PendingPairing | null>;
  /** The local verdict: `match` is "Sí, fui yo" (false while waiting cancels); `typed` carries the
   * replace-account phrase. */
  confirmPairing(pairingId: string, match: boolean, typed?: string): Promise<PendingPairing | void>;
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
  /** Starts the app's own sign-in here (CLI login opens the browser; apps just open). Rejects with
   * `blocked_by_policy`. */
  signinApp(appId: string): Promise<void>;
  disconnectApp(appId: string): Promise<void>;
  /** The person's local yes: the app's official install (or its official download page). */
  installApp(appId: string): Promise<void>;
  /** The person's no to a remote install request. */
  declineAppInstall(appId: string): Promise<void>;
  /** Opens the app on this computer. */
  launchApp(appId: string): Promise<void>;
  /** "Usar" / "se actualizó: confirmar": trust the CLI as shown; the agent re-hashes it and refuses with
   * `pin_mismatch` if it no longer matches `sha256`. */
  pinApp(appId: string, sha256: string): Promise<void>;
  /** The folders Chalito may work in. */
  workspaces(): Promise<{ workspaces: Workspace[] }>;
  /** A folder from the OS picker; the agent asks the OS (password or biometric) before adding it. */
  addWorkspace(path: string): Promise<AddWorkspaceResult>;
  removeWorkspace(label: string): Promise<{ removed: boolean }>;
  /** Custom recipes: what enabling one runs, then the local enable (the agent asks the OS itself). */
  customRecipeChallenge(appId: string): Promise<CustomChallenge>;
  enableCustomRecipe(appId: string, answers: { review: boolean; typed: string }): Promise<CustomEnableResult>;
  disableCustomRecipe(appId: string): Promise<void>;
  /** An app's sessions on this computer: allowed only here (OS check, review, typed id). */
  appSessionsChallenge(appId: string): Promise<CustomChallenge>;
  enableAppSessions(appId: string, answers: { review: boolean; typed: string }): Promise<SessionsEnableResult>;
  disableAppSessions(appId: string): Promise<void>;
  /** Computer control: reading isn't the indicator's heartbeat (the native side sends it); enabling asks
   * the OS in the agent and re-checks the answers. */
  computerStatus(): Promise<ComputerStatus>;
  /** Coordinator mode: turned on only here (the agent asks the OS, then the person's yes). */
  coordinatorStatus(): Promise<CoordinatorStatus>;
  coordinatorChallenge(): Promise<CoordinatorChallenge>;
  enableCoordinator(answers: { confirm: boolean }): Promise<CoordinatorEnableResult>;
  disableCoordinator(): Promise<void>;
  computerChallenge(): Promise<ComputerChallenge>;
  enableComputer(answers: ComputerAnswers): Promise<ComputerEnableResult>;
  disableComputer(): Promise<void>;
  /** The panel's kill switch (through the native side, like the hotkey and the tray item). */
  stopComputer(): Promise<void>;
  /** Native, not the agent: macOS Screen Recording / Accessibility, Wayland on Linux. */
  computerPermissions(): Promise<ComputerPermissions>;
  openComputerSettings(pane: "screenRecording" | "accessibility"): Promise<void>;
  /** Remote terminal: enabling asks the OS and re-checks the answers (raw shell: stronger); open terminals
   * stop with the computer-control kill switch. */
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
  /** Agent-to-agent links (ADR 0022 §3, D-070): hand-off links are made only here, after the OS check, the
   * confirmation and the typed phrase. */
  links(): Promise<LinksView>;
  linkChallenge(mode: LinkMode): Promise<LinkChallenge>;
  addLink(link: LinkSpec, answers: { confirm: boolean; typed: string }): Promise<LinkAddResult>;
  revokeLink(linkId: string): Promise<{ revoked: boolean }>;
  revokeAllLinks(): Promise<{ revoked: number }>;
  // ADR 0031 §1: "Nueva sesión", sessions started here with origin `local`.
  codeApps(): Promise<{ apps: string[]; workspaces: string[] }>;
  codeStart(i: {
    appId: string;
    workspaceLabel: string;
    prompt: string;
    permissionMode: CodeMode;
  }): Promise<{ sid: string }>;
  codePrompt(sid: string, text: string): Promise<void>;
  codeStop(sid: string): Promise<void>;
  /** "Ver sesiones que abrí yo": off by default; read-only, and nothing of it leaves this computer. */
  ownSessions(): Promise<{ enabled: boolean; sessions: OwnSessionView[] }>;
  setOwnSessions(enabled: boolean): Promise<{ enabled: boolean }>;
  openOwnSession(key: string): Promise<OwnOpenResult>;
  /** The person's GitHub PRs through their own `gh` (off until they turn it on). */
  /** `probe` (Settings only) also asks whether `gh` is signed in while the watch is off. */
  prWatch(o?: { probe?: boolean }): Promise<PrWatchView>;
  setPrWatch(c: PrWatchSettings): Promise<PrWatchView>;
}

export type CodeMode = "default" | "plan" | "acceptEdits";

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
  startPairing: unavailable,
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
  pinApp: unavailable,
  workspaces: unavailable,
  addWorkspace: unavailable,
  removeWorkspace: unavailable,
  customRecipeChallenge: unavailable,
  enableCustomRecipe: unavailable,
  disableCustomRecipe: unavailable,
  appSessionsChallenge: unavailable,
  enableAppSessions: unavailable,
  disableAppSessions: unavailable,
  computerStatus: unavailable,
  coordinatorStatus: unavailable,
  coordinatorChallenge: unavailable,
  enableCoordinator: unavailable,
  disableCoordinator: unavailable,
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
  links: unavailable,
  linkChallenge: unavailable,
  addLink: unavailable,
  revokeLink: unavailable,
  revokeAllLinks: unavailable,
  codeApps: unavailable,
  codeStart: unavailable,
  codePrompt: unavailable,
  codeStop: unavailable,
  ownSessions: unavailable,
  setOwnSessions: unavailable,
  openOwnSession: unavailable,
  prWatch: unavailable,
  setPrWatch: unavailable,
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
    startPairing: (kind) => call("startPairing", kind ? { kind } : {}),
    pendingPairing: () => call("pendingPairing"),
    confirmPairing: (pairingId, match, typed) =>
      call("confirmPairing", { pairingId, match, ...(typed !== undefined ? { typed } : {}) }),
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
    pinApp: async (appId, sha256) => void (await call("pinApp", { appId, sha256 })),
    workspaces: () => call("workspaces"),
    addWorkspace: (path) => call("addWorkspace", { path }),
    removeWorkspace: (label) => call("removeWorkspace", { label }),
    customRecipeChallenge: (appId) => call("customRecipeChallenge", { appId }),
    enableCustomRecipe: (appId, answers) => call("enableCustomRecipe", { appId, answers }),
    disableCustomRecipe: async (appId) => void (await call("disableCustomRecipe", { appId })),
    appSessionsChallenge: (appId) => call("appSessionsChallenge", { appId }),
    enableAppSessions: (appId, answers) => call("enableAppSessions", { appId, answers }),
    disableAppSessions: async (appId) => void (await call("disableAppSessions", { appId })),
    // No `indicatorShown`: only the native poller's report counts as the indicator's heartbeat.
    computerStatus: () => call("computerStatus"),
    computerChallenge: () => call("computerChallenge"),
    coordinatorStatus: () => call("coordinatorStatus"),
    coordinatorChallenge: () => call("coordinatorChallenge"),
    enableCoordinator: (answers) => call("enableCoordinator", { answers }),
    disableCoordinator: async () => void (await call("disableCoordinator")),
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
    links: () => call("linkList"),
    linkChallenge: (mode) => call("linkChallenge", { mode }),
    addLink: (link, answers) => call("linkAdd", { link, answers }),
    revokeLink: (linkId) => call("linkRevoke", { linkId }),
    revokeAllLinks: () => call("linkRevokeAll"),
    codeApps: () => call("codeApps"),
    codeStart: (i) => call("codeStart", { ...i }),
    codePrompt: async (sid, text) => void (await call("codePrompt", { sid, text })),
    codeStop: async (sid) => void (await call("codeStop", { sid })),
    ownSessions: () => call("ownSessions"),
    setOwnSessions: (enabled) => call("ownSessionsSet", { enabled }),
    openOwnSession: (key) => call("ownSessionOpen", { key }),
    prWatch: (o) => call("prWatch", o?.probe ? { probe: true } : undefined),
    setPrWatch: (c) => call("setPrWatch", { ...c }),
  };
};

export const agentIpc = (): AgentIpc => (isTauri() ? invokeIpc() : unavailableIpc);
