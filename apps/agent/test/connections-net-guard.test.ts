import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { lookupFetch, publicFetch, publicRemoteUrl } from "../src/connections/net-guard.js";
import { ConnectorError, HttpTransport } from "../src/connections/transport.js";

// The guarded fetch is plain node:http(s), so it runs the same under Node (here) and Bun (the shipped agent).
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  let connections = 0;
  server.on("connection", () => void connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
};
// A name only this test can resolve: it reaches the local server through the lookup, as a real DNS answer would.
const toLocal: LookupFunction = (_h, o, cb) =>
  o.all
    ? (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: "127.0.0.1", family: 4 },
      ])
    : cb(null, "127.0.0.1", 4);

describe("lookupFetch: fetch over node:http with its own lookup", () => {
  it("returns a streaming Response with status, headers and an SSE body, resolved through the lookup", async () => {
    const seen: { host?: string; auth?: string; body: string; length?: string }[] = [];
    const { port } = await listen((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({
          host: req.headers.host,
          auth: req.headers.authorization,
          body,
          length: req.headers["content-length"],
        });
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
        res.write('data: {"id":1}\n\n');
        setTimeout(() => res.end('data: {"id":2}\n\n'), 20);
      });
    });
    const r = await lookupFetch(toLocal)(`http://svc.example.com:${port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"a":"ñ"}',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBe("s-1");
    expect(await r.text()).toBe('data: {"id":1}\n\ndata: {"id":2}\n\n');
    expect(seen).toEqual([{ host: `svc.example.com:${port}`, auth: "Bearer t", body: '{"a":"ñ"}', length: "10" }]);
  });

  it("refuses a redirect instead of following it, and gives a 202/204 an empty body", async () => {
    let followed = 0;
    const target = await listen((_req, res) => (followed++, res.writeHead(200).end()));
    const redirect = await listen((_req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/` }).end(),
    );
    await expect(
      lookupFetch(toLocal)(`http://svc.example.com:${redirect.port}/`, { method: "POST", body: "{}" }),
    ).rejects.toThrow("redirect refused");
    expect(followed).toBe(0);
    const empty = await listen((req, res) => res.writeHead(req.method === "DELETE" ? 204 : 202).end());
    const a = await lookupFetch(toLocal)(`http://svc.example.com:${empty.port}/`, { method: "POST", body: "{}" });
    expect([a.status, await a.text()]).toEqual([202, ""]);
    const d = await lookupFetch(toLocal)(`http://svc.example.com:${empty.port}/`, { method: "DELETE" });
    expect([d.status, d.body]).toEqual([204, null]);
  });

  it("an abort ends a body that is still streaming, and an already-aborted signal never connects", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
    });
    const ac = new AbortController();
    const r = await lookupFetch(toLocal)(`http://svc.example.com:${srv.port}/`, { method: "POST", signal: ac.signal });
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
    const before = srv.connections();
    await expect(
      lookupFetch(toLocal)(`http://svc.example.com:${srv.port}/`, { method: "POST", signal: ac.signal }),
    ).rejects.toThrow("aborted");
    expect(srv.connections()).toBe(before);
  });

  it("drives HttpTransport end to end: session header, notifications, DELETE on close", async () => {
    const methods: string[] = [];
    const srv = await listen((req, res) => {
      if (req.method === "DELETE")
        return (methods.push(`DELETE ${String(req.headers["mcp-session-id"])}`), res.writeHead(200).end());
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const msg = JSON.parse(raw) as { id?: number; method: string };
        methods.push(msg.method);
        if (msg.id === undefined) return res.writeHead(202).end();
        res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-9" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: msg.method } }));
      });
    });
    const t = new HttpTransport(
      `http://localhost:${srv.port}/mcp`,
      {},
      { publicOnly: false, fetch: lookupFetch(toLocal) },
    );
    await t.start();
    expect(await t.request("initialize", {}, 5000)).toEqual({ ok: "initialize" });
    t.notify("notifications/initialized");
    expect(await t.request("tools/list", {}, 5000)).toEqual({ ok: "tools/list" });
    await t.close();
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE sess-9"]);
  });
});

describe("HttpTransport over the guarded fetch: error codes", () => {
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) => (e instanceof ConnectorError ? e.code : String(e)),
    );

  it("a refused private answer has its own code; a name that doesn't resolve stays unavailable", async () => {
    const answers = (list: { address: string; family: number }[]) =>
      ((_h: string, _o: unknown, cb: (e: null, a: typeof list) => void) => cb(null, list)) as never;
    const notFound = ((_h: string, _o: unknown, cb: (e: Error) => void) =>
      cb(Object.assign(new Error("nope"), { code: "ENOTFOUND" }))) as never;
    const at = (lookup: never) =>
      new HttpTransport("https://mcp.example.com/mcp", {}, { publicOnly: true, lookup }).request(
        "initialize",
        {},
        5000,
      );
    expect(await codeOf(at(answers([{ address: "10.1.2.3", family: 4 }])))).toBe("connector_private_address");
    expect(await codeOf(at(notFound))).toBe("connector_unavailable");
  });

  it("a 401 is unauthorized and its unread body doesn't keep the socket open", async () => {
    let closed = false;
    const srv = await listen((req, res) => {
      req.socket.once("close", () => (closed = true));
      res.writeHead(401, { "content-type": "text/plain" });
      res.write("x".repeat(64 * 1024)); // never ended
    });
    const t = new HttpTransport(
      `http://localhost:${srv.port}/mcp`,
      {},
      { publicOnly: false, fetch: lookupFetch(toLocal) },
    );
    expect(await codeOf(t.request("initialize", {}, 5000))).toBe("connector_unauthorized");
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });

  it("a non-string body is refused instead of being sent empty", async () => {
    const srv = await listen((_req, res) => res.writeHead(200).end());
    await expect(
      lookupFetch(toLocal)(`http://svc.example.com:${srv.port}/`, { method: "POST", body: new Uint8Array([1]) }),
    ).rejects.toThrow("string body only");
    expect(srv.connections()).toBe(0);
  });
});

describe("publicFetch: verified and registry connectors", () => {
  it("accepts only HTTPS to a public DNS name, without credentials", () => {
    expect(publicRemoteUrl("https://mcp.linear.app/mcp")).toBe(true);
    for (const bad of [
      "http://mcp.linear.app/mcp",
      "https://127.0.0.1/mcp",
      "https://8.8.8.8/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      "https://printer.local/mcp",
      "https://intranet/mcp",
      "https://u:p@mcp.linear.app/mcp",
      "not a url",
    ])
      expect(publicRemoteUrl(bad), bad).toBe(false);
  });

  it("refuses before connecting when any resolved address is private, and never takes a URL it can't check", async () => {
    const srv = await listen((_req, res) => res.writeHead(200).end());
    const answers = (list: { address: string; family: number }[]) =>
      ((_h: string, _o: unknown, cb: (e: null, a: typeof list) => void) => cb(null, list)) as never;
    for (const list of [
      [{ address: "127.0.0.1", family: 4 }],
      [
        { address: "1.1.1.1", family: 4 },
        { address: "192.168.1.10", family: 4 },
      ],
      [{ address: "fd00::1", family: 6 }],
      [],
    ])
      await expect(
        publicFetch(answers(list))(`https://rebind.example.com:${srv.port}/mcp`, { method: "POST", body: "{}" }),
      ).rejects.toThrow();
    await expect(publicFetch()(`http://127.0.0.1:${srv.port}/`, { method: "POST" })).rejects.toThrow(
      "not a public https url",
    );
    expect(srv.connections()).toBe(0);
  });
});
