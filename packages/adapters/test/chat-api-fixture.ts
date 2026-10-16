import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A mocked OpenAI-compatible Chat Completions server on loopback: `POST /v1/chat/completions`
 * with `stream: true` answers in server-sent events (`data: {chunk}` … `data: [DONE]`), the shape
 * the providers' docs give (OpenAI-style deltas, tool_calls by index, usage on the last chunk).
 * `GET /v1/models` lists models. Each request is answered with the next scripted reply.
 */
export type MockReply =
  | { text: string; usage?: Record<string, unknown>; groqUsage?: boolean }
  | { tools: { name: string; args: Record<string, unknown> }[]; text?: string }
  | { status: number; body?: string }
  | { hang: true };

export interface MockRequest {
  path: string;
  auth: string | undefined;
  headers: IncomingMessage["headers"];
  body: {
    model?: string;
    stream?: boolean;
    stream_options?: unknown;
    tools?: { type: string; function: { name: string } }[];
    messages: { role: string; content: string | null; tool_calls?: { id: string }[]; tool_call_id?: string }[];
  };
  aborted: boolean;
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

export const startMockChat = async (opts: { models?: string[] } = {}) => {
  const script: MockReply[] = [];
  const requests: MockRequest[] = [];
  let calls = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: (opts.models ?? []).map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const r: MockRequest = {
        path,
        auth: req.headers.authorization,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        aborted: false,
      };
      requests.push(r);
      res.on("close", () => {
        if (!res.writableFinished) r.aborted = true;
      });
      const reply = script.shift() ?? { text: "" };
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body ?? JSON.stringify({ error: { message: "nope" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if ("hang" in reply) {
        res.write(": keep-alive\n\n");
        return;
      }
      const id = `chatcmpl-${++calls}`;
      const base = { id, object: "chat.completion.chunk", created: 1, model: r.body.model };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }));
      const text = "text" in reply && reply.text ? reply.text : "";
      // Text in two deltas, to check they're joined.
      for (const part of text ? [text.slice(0, 2), text.slice(2)] : [])
        if (part) res.write(sse({ ...base, choices: [{ index: 0, delta: { content: part } }] }));
      if ("tools" in reply) {
        for (const [i, t] of reply.tools.entries()) {
          const args = JSON.stringify(t.args);
          // Name first, then the arguments split across two deltas (as providers stream them).
          res.write(
            sse({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: `call_${calls}_${i}`,
                        type: "function",
                        function: { name: t.name, arguments: "" },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          for (const part of [args.slice(0, 3), args.slice(3)])
            res.write(
              sse({
                ...base,
                choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] } }],
              }),
            );
        }
      }
      const finish = "tools" in reply ? "tool_calls" : "stop";
      const usage = ("usage" in reply && reply.usage) || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if ("groqUsage" in reply && reply.groqUsage)
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], x_groq: { id, usage } }));
      else {
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
        res.write(sse({ ...base, choices: [], usage }));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    baseUrl,
    script,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
};
