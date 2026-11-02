import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { openRpc, type Rpc } from "../code/cli.js";
import { CODE_MAX_LINE } from "../code/server.js";
import { MCP_PROTOCOL_VERSIONS } from "../computer/mcp-server.js";
import { CONNECTOR_DATA_RULE } from "./risk.js";

export const CONNECTIONS_SERVER = "chalito-connections";
const INSTRUCTIONS =
  "Tools from the connections installed in Chalito on this computer, named <connection>__<tool>. " +
  "Each description starts with [Verificado] or [Comunidad]. Chalito may ask the person to approve a call on their phone. " +
  CONNECTOR_DATA_RULE;

type Json = Record<string, unknown>;

export interface ConnectionsMcpIo {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  /** code.sock (or the Windows pipe); null when this build can't reach the agent safely. */
  path: string | null;
  app?: string;
  openPipe?: () => { ok: true; stream: Duplex } | { ok: false };
  connect?: (path: string) => Duplex;
  version?: string;
  connectMs?: number;
}

const NOT_RUNNING =
  "Chalito isn't running on this computer, so its connections are unavailable. Open Chalito and try again.";

/** `chalito-agent connections mcp [app]`: the stdio MCP server an AI app launches; the agent does the rest. */
export const runConnectionsMcp = (io: ConnectionsMcpIo): Promise<void> =>
  new Promise((resolve) => {
    let rpc: Rpc | null = null;
    let opening: Promise<Rpc | null> | null = null;
    const open = (): Promise<Rpc | null> => {
      if (rpc) return Promise.resolve(rpc);
      if (opening) return opening;
      opening = (async () => {
        if (!io.path) return null;
        let sock: Duplex | null;
        if (io.openPipe) {
          const o = io.openPipe();
          sock = o.ok ? o.stream : null;
        } else
          sock = await new Promise<Duplex | null>((done) => {
            const s = (io.connect ?? connect)(io.path!);
            const timer = setTimeout(() => {
              s.destroy();
              done(null);
            }, io.connectMs ?? 2000);
            s.once("connect", () => {
              clearTimeout(timer);
              done(s);
            });
            s.once("error", () => {
              clearTimeout(timer);
              s.destroy();
              done(null);
            });
          });
        if (!sock) return null;
        const r = openRpc(
          sock,
          () => undefined,
          () => {
            if (rpc === r) rpc = null;
          },
        );
        rpc = r;
        return r;
      })().finally(() => (opening = null));
      return opening;
    };
    const app = io.app ? { app: io.app } : {};

    const handle = async (msg: Json): Promise<Json | null> => {
      const id = msg.id as string | number | undefined;
      const method = typeof msg.method === "string" ? msg.method : "";
      if (id === undefined || id === null) return null;
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      const params = (msg.params ?? {}) as Json;
      switch (method) {
        case "initialize": {
          const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          return ok({
            protocolVersion: (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
              ? asked
              : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: CONNECTIONS_SERVER, title: "Chalito connections", version: io.version ?? "0.0.0" },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return ok({});
        case "tools/list": {
          const r = await open();
          const res = r ? await r.call("connections.list", app) : null;
          const tools = res?.ok ? (res.result as { tools?: unknown }).tools : [];
          return ok({ tools: Array.isArray(tools) ? tools : [] });
        }
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const body = { ...app, name, arguments: params.arguments ?? {} };
          if (JSON.stringify({ id: 1, method: "connections.call", params: body }).length > CODE_MAX_LINE - 64)
            return ok({
              content: [{ type: "text", text: "These arguments are too large for a connection call." }],
              isError: true,
            });
          const r = await open();
          const res = r ? await r.call("connections.call", body) : null;
          if (!res?.ok)
            return ok({
              content: [
                { type: "text", text: res ? `Chalito couldn't run this call (${res.error ?? "error"}).` : NOT_RUNNING },
              ],
              isError: true,
            });
          return ok(res.result);
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method.slice(0, 64)}` } };
      }
    };

    let buf = "";
    const inflight = new Set<Promise<void>>();
    const line = (text: string) => {
      if (!text.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(text) as Json;
      } catch {
        io.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        return;
      }
      const p = handle(msg)
        .then((reply) => {
          if (reply) io.write(`${JSON.stringify(reply)}\n`);
        })
        .catch(() => {
          if (msg.id !== undefined)
            io.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } })}\n`,
            );
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    };
    io.input.setEncoding?.("utf8");
    io.input.on("data", (chunk: string | Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const one = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        line(one);
      }
      // One request can't hold the process's memory hostage.
      if (buf.length > 4 * CODE_MAX_LINE) buf = "";
    });
    io.input.once(
      "end",
      () =>
        void Promise.allSettled([...inflight]).then(() => {
          rpc?.close();
          resolve();
        }),
    );
  });
