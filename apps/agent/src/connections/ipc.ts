import { z } from "zod";
import { IpcError, type IpcHandlers } from "../ipc-server.js";
import { scanFound, type FoundDeps, type FoundTool } from "./found.js";
import { channelErrorCode, isChannelTool, type ChannelInstaller, type ChannelView } from "./install-channel.js";

/** A found tool as the panel shows it; `channel` only for tools Chalito can connect. */
export type FoundRow = FoundTool & { channel?: ChannelView };

export interface FoundFeature {
  installer: ChannelInstaller;
  scan?: Partial<FoundDeps>;
  warn?: (event: string, meta: Record<string, unknown>) => void;
}

const ToolId = z.object({ id: z.string().min(1).max(64) }).strict();

/** "Encontradas en esta PC": scan, connect, disconnect. */
export const foundHandlers = (f: FoundFeature | undefined): IpcHandlers => {
  const of = (): FoundFeature => {
    if (!f) throw new IpcError("unavailable");
    return f;
  };
  const change = async (params: unknown, on: boolean) => {
    const feature = of();
    const r = ToolId.safeParse(params);
    if (!r.success) throw new IpcError("bad_params");
    const { id } = r.data;
    if (!isChannelTool(id)) throw new IpcError("unknown_tool");
    // Connect only what the scan finds here: never create a config for a tool that isn't installed.
    if (on && !(await scanFound(feature.scan ?? {})).some((t) => t.id === id)) throw new IpcError("not_installed");
    try {
      await (on ? feature.installer.connect(id) : feature.installer.disconnect(id));
    } catch (error) {
      const code = channelErrorCode(error);
      // `internal` tells the person nothing: keep the real cause in the log.
      if (code === "internal")
        feature.warn?.("connections.channel_failed", { id, error: error instanceof Error ? error.message : "error" });
      throw new IpcError(code);
    }
    return { ok: true };
  };
  return {
    connectionsFound: async (): Promise<FoundRow[]> => {
      const { installer, scan } = of();
      const tools = await scanFound(scan ?? {});
      // One read per tool: `connected` comes from the same view the row shows.
      return Promise.all(
        tools.map(async (t) => {
          if (!isChannelTool(t.id)) return t;
          const channel = await installer.view(t.id);
          return { ...t, connected: channel.connected, channel };
        }),
      );
    },
    connectionsConnect: (params) => change(params, true),
    connectionsDisconnect: (params) => change(params, false),
  };
};
