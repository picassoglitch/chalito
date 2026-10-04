import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, guard, MemoryBuckets, type BucketStore, type RouteTable } from "../src/index.js";
import { probeLimits, servedRoutes } from "../src/testing.js";

const TABLE: RouteTable = {
  "GET /healthz": { capacity: 3, refillPerSec: 1, bodyBytes: 0 },
  "POST /v1/things/:id": { capacity: 2, refillPerSec: 1, bodyBytes: 64 },
  "ALL /mcp": { capacity: 2, refillPerSec: 1, bodyBytes: 32, shared: true },
};

const build = (opts: Parameters<typeof guard>[1] = {}) => {
  const app = new Hono();
  app.use("*", guard(TABLE, opts));
  app.use("/v1/*", async (_c, next) => next());
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.post("/v1/things/:id", async (c) => c.json({ got: (await c.req.text()).length }));
  app.all("/mcp", (c) => c.json({ ok: true }));
  return app;
};
const req = (app: Hono, path: string, init: RequestInit & { ip?: string } = {}) =>
  app.request(`http://x${path}`, { ...init, headers: { "x-forwarded-for": init.ip ?? "1.1.1.1", ...init.headers } });

describe("guard", () => {
  it("lists served routes, counting app.all handlers but not middleware", () => {
    expect(servedRoutes(build())).toEqual(["ALL /mcp", "GET /healthz", "POST /v1/things/:id"]);
  });

  it("limits each route per client IP, with Retry-After, and refills over time", async () => {
    let t = 0;
    const app = build({ now: () => t });
    for (let i = 0; i < 3; i++) expect((await req(app, "/healthz")).status).toBe(200);
    const r = await req(app, "/healthz");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect((await req(app, "/healthz", { ip: "2.2.2.2" })).status).toBe(200);
    t += 1000;
    expect((await req(app, "/healthz")).status).toBe(200);
  });

  it("keys on the rightmost X-Forwarded-For entry, which a client can't forge", async () => {
    const app = build({ now: () => 0 });
    for (let i = 0; i < 3; i++) await req(app, "/healthz", { ip: `${i}.0.0.1, 9.9.9.9` });
    expect((await req(app, "/healthz", { ip: "spoofed, 9.9.9.9" })).status).toBe(429);
  });

  it("caps bodies by Content-Length and by what is actually streamed", async () => {
    const app = build();
    expect((await req(app, "/v1/things/a", { method: "POST", body: "x".repeat(64) })).status).toBe(200);
    expect((await req(app, "/v1/things/a", { method: "POST", body: "x".repeat(65), ip: "3.3.3.3" })).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(200)));
        c.close();
      },
    });
    const r = await req(app, "/v1/things/a", {
      method: "POST",
      body: stream,
      ip: "4.4.4.4",
      duplex: "half",
    } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("unknown paths get the strict default", async () => {
    const app = build({ now: () => 0 });
    const codes = [];
    for (let i = 0; i <= DEFAULT_LIMIT.capacity; i++) codes.push((await req(app, "/wp-login.php")).status);
    expect(codes.at(-1)).toBe(429);
    expect(codes.slice(0, -1).every((c) => c === 404)).toBe(true);
  });

  it("shared routes use the shared store, and fall back to memory when it's down", async () => {
    const calls: string[] = [];
    const shared: BucketStore = {
      take: async (k, cap, rate, now) => {
        calls.push(k);
        return new MemoryBuckets().take(k, cap, rate, now);
      },
    };
    await req(build({ shared }), "/mcp", { method: "POST" });
    expect(calls).toHaveLength(1);
    const down: BucketStore = { take: async () => Promise.reject(new Error("db down")) };
    const app = build({ shared: down, now: () => 0 });
    const s = [];
    for (let i = 0; i < 3; i++) s.push((await req(app, "/mcp", { method: "POST" })).status);
    expect(s).toEqual([200, 200, 429]);
  });

  it("probeLimits passes a fully guarded app and names the gaps in a loose one", async () => {
    expect(await probeLimits(build({ now: () => 0 }), TABLE)).toEqual([]);
    const loose = new Hono();
    loose.get("/healthz", (c) => c.json({ ok: true }));
    expect(await probeLimits(loose, { "GET /healthz": TABLE["GET /healthz"]! })).toEqual([
      "GET /healthz: request 4 wasn't limited",
    ]);
  });
});
