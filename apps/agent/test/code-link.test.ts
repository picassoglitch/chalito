import { duplexPair, PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { runCode } from "../src/code/cli.js";

it("/link prints the current session's phone link without sending a prompt to its AI", async () => {
  const [client, server] = duplexPair();
  const input = new PassThrough();
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  let output = "";
  let buffer = "";
  server.setEncoding("utf8");
  server.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const request = JSON.parse(buffer.slice(0, end)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      buffer = buffer.slice(end + 1);
      requests.push(request);
      const result =
        request.method === "apps" ? { apps: ["claude-code"], workspaces: ["work"] } : { sid: "session-123" };
      server.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    }
  });
  input.end("/link\n/exit\n");
  try {
    const result = await runCode(
      {
        input,
        out: (s) => {
          output += s;
        },
        err: (s) => {
          output += s;
        },
        env: {},
        cwd: "/work",
        openPipe: () => ({ ok: true, stream: client }),
      },
      "/unused",
      ["claude", "--workspace", "work", "hello"],
      "en",
    );
    expect(result).toBe(0);
    expect(output).toContain("https://www.chalyb.com/en/app/chalito/sesiones/session-123");
    expect(requests.some((r) => r.method === "prompt")).toBe(false);
    expect(requests.find((r) => r.method === "start")?.params?.prompt).toBe("hello");
  } finally {
    client.destroy();
    server.destroy();
    input.destroy();
  }
});
