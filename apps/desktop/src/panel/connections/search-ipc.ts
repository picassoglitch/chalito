import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { IPC_UNAVAILABLE, IpcUnavailableError } from "../../lib/ipc.js";

// The agent's Conexiones search + install calls (apps/agent/src/connections/ipc.ts), kept apart from AgentIpc.

export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  source: "verified" | "community" | "custom";
  transport: "remote" | "stdio";
  server: { url?: string } | { package: string; version: string; integrity?: string; command: string; args: string[] };
  auth: "none" | "token" | "oauth";
  held?: "oauth";
}
export interface InputSpec {
  name: string;
  as: "env" | "header";
  secret: boolean;
  required: boolean;
  prefix?: string;
  description?: string;
}
export type ConnectorRef =
  | { kind: "verified"; id: string }
  | { kind: "registry"; name: string; version: string }
  | { kind: "url"; name: string; url: string; token: boolean }
  | { kind: "command"; name: string; command: string; args: string[]; env: string[] };

export interface SearchItem {
  ref: ConnectorRef;
  entry: ConnectorEntry;
  inputs: InputSpec[];
  installed: boolean;
  repository?: string | null;
}
export interface SearchView {
  verified: SearchItem[];
  community: SearchItem[];
  nextCursor: string | null;
  skipped: number;
  /** The registry didn't answer; the verified ones are still listed. */
  error: string | null;
}
export type InstalledView = ConnectorEntry & {
  installedAt: number | string;
  confirmedWarning: boolean;
  slots: string[];
};
export interface CheckView {
  entry: ConnectorEntry;
  inputs: InputSpec[];
  held: "oauth" | null;
}

export interface ConnectionsSearchIpc {
  search(q: string, cursor?: string): Promise<SearchView>;
  installed(): Promise<InstalledView[]>;
  check(ref: ConnectorRef): Promise<CheckView>;
  install(p: {
    ref: ConnectorRef;
    values: Record<string, string>;
    confirmed: boolean;
    warningAccepted: boolean;
  }): Promise<void>;
  uninstall(id: string): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const invokeConnectionsSearchIpc = (invoke: Invoke = tauriInvoke): ConnectionsSearchIpc => {
  const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>("agent_ipc", { method, params: params ?? null });
    } catch (e) {
      const code = typeof e === "string" ? e : e instanceof Error ? e.message : "internal";
      throw code === IPC_UNAVAILABLE ? new IpcUnavailableError() : new Error(code);
    }
  };
  return {
    search: (q, cursor) => call("connectionsSearch", { q, ...(cursor ? { cursor } : {}) }),
    installed: async () => (await call<{ installed: InstalledView[] }>("connectionsInstalled")).installed,
    check: (ref) => call("connectionsCheck", { ref }),
    install: async (p) => void (await call("connectionsInstall", { ...p })),
    uninstall: async (id) => void (await call("connectionsUninstall", { id })),
  };
};

const unavailable = () => Promise.reject(new IpcUnavailableError());
export const unavailableConnectionsSearchIpc: ConnectionsSearchIpc = {
  search: unavailable,
  installed: unavailable,
  check: unavailable,
  install: unavailable,
  uninstall: unavailable,
};

export const connectionsSearchIpc = (): ConnectionsSearchIpc =>
  isTauri() ? invokeConnectionsSearchIpc() : unavailableConnectionsSearchIpc;
