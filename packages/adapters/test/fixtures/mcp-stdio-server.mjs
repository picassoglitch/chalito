// A stdio MCP server shaped like Chalito's computer-control one (apps/agent/src/computer/mcp-server.ts):
// newline-delimited JSON-RPC 2.0, protocol 2025-11-25, two tools. For the chat-api tool bridge test.
import { createInterface } from "node:readline";

const tools = [
  { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object", properties: {} } },
  {
    name: "click",
    description: "Click at x, y",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
  },
];
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.id === null) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chalito_computer", version: "0.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools });
    case "tools/call": {
      const a = msg.params?.arguments ?? {};
      if (msg.params?.name === "click")
        return ok({ content: [{ type: "text", text: `clicked ${a.x},${a.y} env=${process.env.CHALITO_TEST_TOKEN}` }] });
      return ok({
        content: [
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "text", text: "1280x800" },
        ],
      });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
