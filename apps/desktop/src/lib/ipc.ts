import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import type { DevModeToggle, Provider, ProviderConnectionDoc } from "@chalito/protocol";

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

/** One provider as the agent sees it on this computer (apps/agent/src/providers.ts `ProviderView`). */
export interface ProviderView {
  provider: Provider;
  /** The same status doc the agent reports to chalito.connections. */
  doc: ProviderConnectionDoc;
  /** providers.yaml lets this person use the provider's own plan sign-in. */
  signinAllowed: boolean;
  /** A remote install (from the phone or the web) waiting for a yes here, until this time. */
  installRequestedUntil: number | null;
}

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
  /** "IA conectadas": the four providers' state on this computer. */
  providers(): Promise<ProviderView[]>;
  /** Saves the key in this computer's keychain (it goes over the local socket only). */
  connectProviderKey(provider: Provider, key: string): Promise<void>;
  /** Starts the provider's own sign-in; it opens the browser here. Rejects with `blocked_by_policy`. */
  signinProvider(provider: Provider): Promise<void>;
  disconnectProvider(provider: Provider): Promise<void>;
  /** The person's local yes: installs the official package, then pins it. */
  installProvider(provider: Provider): Promise<void>;
  /** The person's no to a remote install request. */
  declineProviderInstall(provider: Provider): Promise<void>;
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
  providers: unavailable,
  connectProviderKey: unavailable,
  signinProvider: unavailable,
  disconnectProvider: unavailable,
  installProvider: unavailable,
  declineProviderInstall: unavailable,
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
    providers: () => call("providers"),
    connectProviderKey: async (provider, key) => void (await call("connectProviderKey", { provider, key })),
    signinProvider: async (provider) => void (await call("signinProvider", { provider })),
    disconnectProvider: async (provider) => void (await call("disconnectProvider", { provider })),
    installProvider: async (provider) => void (await call("installProvider", { provider })),
    declineProviderInstall: async (provider) => void (await call("declineProviderInstall", { provider })),
  };
};

export const agentIpc = (): AgentIpc => (isTauri() ? invokeIpc() : unavailableIpc);
