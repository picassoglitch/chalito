import { createInterface } from "node:readline";
import type { BrokerReply } from "./broker.js";
import { COMPUTER_SERVER, mcpTools } from "./tools.js";

/**
 * `chalito computer mcp`: the stdio MCP server Claude Code or Codex starts for a session when
 * computer control is on (control.ts `attach`). It holds no policy and no native code: every
 * `tools/call` goes to the agent over the broker socket with the session's token, and the agent
 * decides (grant, indicator, rate limit, audit) and acts. Newline-delimited JSON-RPC 2.0, the
 * MCP stdio transport.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Json = Record<string, unknown>;

export interface McpServerIo {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  call: (tool: string, args: unknown) => Promise<BrokerReply>;
  version?: string;
}

const INSTRUCTIONS =
  "Tools to see and use this computer's screen, mouse and keyboard. The first call asks the person " +
  "to approve computer control for this session on their phone; wait for it. Take a screenshot first; " +
  "coordinates are in that screenshot's pixels. The person can stop control at any time.";

export const handleMcpMessage = async (msg: Json, io: Pick<McpServerIo, "call" | "version">): Promise<Json | null> => {
  const id = msg.id as string | number | undefined;
  const method = typeof msg.method === "string" ? msg.method : "";
  // Notifications (no id) get no reply.
  if (id === undefined || id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: COMPUTER_SERVER, title: "Chalito computer control", version: io.version ?? "0.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: mcpTools() });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const reply = await io.call(name, params.arguments ?? {});
      if (!reply.ok) return ok({ content: [{ type: "text", text: reply.message }], isError: true });
      const content: Json[] = [];
      if (reply.result.image)
        content.push({ type: "image", data: reply.result.image.data, mimeType: reply.result.image.mimeType });
      content.push({ type: "text", text: reply.result.text });
      return ok({ content });
    }
    default:
      return fail(-32601, `Method not found: ${method.slice(0, 64)}`);
  }
};

/** Runs until stdin closes. Calls are answered as they finish (a slow approval doesn't block `ping`). */
export const runMcpServer = (io: McpServerIo): Promise<void> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: io.input, crlfDelay: Infinity });
    const inflight = new Set<Promise<void>>();
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        io.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        return;
      }
      const p = handleMcpMessage(msg, io)
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
    });
    rl.on("close", () => void Promise.allSettled([...inflight]).then(() => resolve()));
  });
