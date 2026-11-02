import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { IPC_UNAVAILABLE, IpcUnavailableError } from "./ipc.js";

/** apps/agent/src/connections/found.ts `FoundTool`. */
export interface FoundTool {
  id: string;
  name: string;
  kind: "agent" | "llm" | "mcp-client";
  path?: string;
  recipeId?: string;
  mcpCapable: boolean;
  connected: boolean;
}
/** Present only for tools whose MCP config Chalito can edit (connections/install-channel.ts). */
export interface ChannelView {
  connected: boolean;
  channel: "ready" | "needs_update";
  configPath: string;
  error?: string;
}
export type FoundRow = FoundTool & { channel?: ChannelView };

/** The agent's "Encontradas en esta PC" calls (apps/agent/src/connections/ipc.ts), kept apart from AgentIpc. */
export interface FoundIpc {
  scan(): Promise<FoundRow[]>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const invokeFoundIpc = (invoke: Invoke = tauriInvoke): FoundIpc => {
  const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>("agent_ipc", { method, params: params ?? null });
    } catch (e) {
      const code = typeof e === "string" ? e : e instanceof Error ? e.message : "internal";
      throw code === IPC_UNAVAILABLE ? new IpcUnavailableError() : new Error(code);
    }
  };
  return {
    scan: () => call("connectionsFound"),
    connect: async (id) => void (await call("connectionsConnect", { id })),
    disconnect: async (id) => void (await call("connectionsDisconnect", { id })),
  };
};

const unavailable = () => Promise.reject(new IpcUnavailableError());
export const unavailableFoundIpc: FoundIpc = { scan: unavailable, connect: unavailable, disconnect: unavailable };

export const foundIpc = (): FoundIpc => (isTauri() ? invokeFoundIpc() : unavailableFoundIpc);
