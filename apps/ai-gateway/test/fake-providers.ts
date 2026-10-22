import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One real HTTP server playing OpenAI, xAI and Gemini: records what reaches it, answers per test. */
export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

export type Behaviour =
  | {
      kind: "responses";
      usage: Record<string, unknown>;
      text?: string;
      stream?: boolean;
      delayMs?: number;
      chunks?: number;
    }
  | { kind: "gemini"; usage: Record<string, unknown>; text?: string; stream?: boolean; chunks?: number }
  | { kind: "status"; status: number; body: unknown }
  /** Sends `chunks` events, then drops the connection before the usage. */
  | { kind: "cut"; chunks: number };

export const responsesSse = (text: string, usage: Record<string, unknown>, chunks = 3) => {
  const ev = (type: string, extra: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  return [
    ev("response.created", { response: { id: "resp_1", status: "in_progress" } }),
    ...Array.from({ length: chunks }, (_, i) => ev("response.output_text.delta", { delta: `${text}${i}` })),
    ev("response.completed", { response: { id: "resp_1", status: "completed", usage } }),
  ];
};

export const geminiSse = (text: string, usage: Record<string, unknown>, chunks = 3) =>
  Array.from({ length: chunks }, (_, i) => {
    const last = i === chunks - 1;
    return `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: `${text}${i}` }] }, ...(last ? { finishReason: "STOP" } : {}) }],
      // Early chunks carry partial counts, as Gemini's do; only the last one is final.
      usageMetadata: last ? usage : { promptTokenCount: usage.promptTokenCount },
    })}\r\n\r\n`;
  });

export class FakeProviders {
  readonly seen: Seen[] = [];
  behaviour: Behaviour = { kind: "status", status: 500, body: {} };
  /** Resolves when a streamed response finished writing everything (even if our client left). */
  streamsDone = 0;
  #server: Server = createServer((req, res) => void this.#handle(req, res));

  async start() {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const raw = await new Promise<string>((r) => {
      let s = "";
      req.on("data", (c: Buffer) => (s += c.toString()));
      req.on("end", () => r(s));
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* none */
    }
    this.seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
    const b = this.behaviour;
    if (req.url?.includes(":countTokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalTokens: 42 }));
      return;
    }
    if (b.kind === "status") {
      res.writeHead(b.status, { "content-type": "application/json" }).end(JSON.stringify(b.body));
      return;
    }
    if (b.kind === "cut") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of responsesSse("partial", {}, b.chunks).slice(0, b.chunks)) res.write(e);
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const usage = b.usage;
    const text = b.text ?? "hola";
    if (b.stream === false) {
      const json =
        b.kind === "responses"
          ? {
              id: "resp_1",
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text }] }],
              usage,
            }
          : { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: usage };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(json));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = b.kind === "responses" ? responsesSse(text, usage, b.chunks) : geminiSse(text, usage, b.chunks);
    const delay = b.kind === "responses" ? (b.delayMs ?? 0) : 0;
    for (const e of events) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // Keep writing even if the gateway stopped reading: the provider doesn't know the CLI left.
      res.write(e);
    }
    res.end();
    this.streamsDone += 1;
  }
}
