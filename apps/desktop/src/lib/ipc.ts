import type { DevModeToggle } from "@chalito/protocol";

/**
 * Local-only surfaces, reached through the agent's IPC (ADR 0004: the agent is a user
 * service; the desktop app talks to it on this machine). They are local on purpose: a
 * remote surface (PWA, phone) can never enable Developer mode or confirm a pairing for this
 * computer. The agent-side IPC server is a follow-up; until it lands the desktop uses
 * `unavailableIpc` and the screens say so.
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
};

/** Mirrors the agent's check, so the button stays disabled until all three are given. */
export const answersComplete = (a: DevModeAnswers, phrase: string): boolean =>
  a.first && a.second && a.liability.checked && a.liability.typed.trim() === phrase;
