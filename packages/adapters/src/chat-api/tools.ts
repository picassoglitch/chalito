import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { LocalMcpServer } from "../core.js";
import type { ChatTool, ChatToolBridge, ChatToolConnector } from "./adapter.js";

/**
 * The tool bridge of a chat-api session: the session's own local MCP servers (today only Chalito's
 * computer control, attached by the agent when the person turned it on), spoken to over stdio with
 * the official MCP client. Each tool is offered to the model as `<server>__<tool>` and reaches the
 * gate as `mcp__<server>__<tool>`, the name Claude Code gives it, so the classifier and approvals
 * treat it the same. The bridge only ever runs a tool after the adapter's gate allowed it.
 */

const FN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOLS = 64;

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: unknown; text?: unknown }) =>
      c?.type === "text" && typeof c.text === "string" ? c.text : c?.type ? `[${String(c.type)} omitted]` : "",
    )
    .filter(Boolean)
    .join("\n");
};

export const connectMcpTools: ChatToolConnector = async (servers) => {
  const clients = new Map<string, Client>();
  const tools: (ChatTool & { server: string; tool: string })[] = [];
  const closeAll = async () => {
    for (const c of clients.values()) await c.close().catch(() => undefined);
  };
  try {
    for (const [server, spec] of Object.entries(servers) as [string, LocalMcpServer][]) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(server)) continue;
      const client = new Client({ name: "chalito-chat-api", version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: "ignore" }),
      );
      clients.set(server, client);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        const name = `${server}__${t.name}`;
        if (!FN_NAME.test(name) || tools.length >= MAX_TOOLS) continue;
        tools.push({
          name,
          description: (t.description ?? t.name).slice(0, 1000),
          parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: "object" },
          toolName: `mcp__${server}__${t.name}`,
          server,
          tool: t.name,
        });
      }
    }
  } catch (err) {
    await closeAll();
    throw err;
  }
  if (!tools.length) {
    await closeAll();
    return null;
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  const bridge: ChatToolBridge = {
    tools: tools.map(({ name, description, parameters, toolName }) => ({ name, description, parameters, toolName })),
    call: async (name, args, signal) => {
      const t = byName.get(name);
      const client = t && clients.get(t.server);
      if (!t || !client) return { ok: false, text: `Error: there is no tool named ${name}.` };
      const r = (await client.callTool({ name: t.tool, arguments: args }, { signal })) as {
        isError?: boolean;
        content?: unknown;
      };
      return { ok: !r.isError, text: textOf(r.content) };
    },
    close: closeAll,
  };
  return bridge;
};
