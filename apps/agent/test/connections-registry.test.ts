import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRegistryServer,
  mapServer,
  probeRemoteAuth,
  REGISTRY_BASE,
  REGISTRY_MAX_BYTES,
  registryId,
  RegistryError,
  safeRemoteUrl,
  searchRegistry,
} from "../src/connections/registry.js";

// Recorded from https://registry.modelcontextprotocol.io/v0.1 on 2026-11-01 (CI runs offline on these).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/registry/${name}`, import.meta.url), "utf8");

/** A real HTTP server standing in for the registry, so the real fetch, caps and parsing run. */
let server: Server;
let base = "";
let lastUrl = "";
const routes = new Map<string, (res: ServerResponse) => void>();
beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? "";
    const path = lastUrl.split("?")[0]!;
    const route = routes.get(path) ?? routes.get(`${req.method} ${path}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const json = (body: string) => (res: ServerResponse) =>
  res.writeHead(200, { "content-type": "application/json" }).end(body);

describe("searchRegistry (recorded fixtures)", () => {
  it("sends the v0.1 query (latest only, search, limit, cursor) and maps the page", async () => {
    routes.set("/v0.1/servers", json(fixture("search-github.json")));
    const page = await searchRegistry("github", "abc:1.0", { base });
    const q = new URL(lastUrl, base).searchParams;
    expect(q.get("version")).toBe("latest");
    expect(q.get("search")).toBe("github");
    expect(q.get("cursor")).toBe("abc:1.0");
    expect(Number(q.get("limit"))).toBeLessThanOrEqual(100);
    expect(page.nextCursor).toBe("io.github.0rkz/byte-protocol:0.13.0");
    expect(page.results.length + page.skipped).toBe(30);
    expect(page.results.length).toBeGreaterThan(0);
    for (const r of page.results) {
      expect(r.entry.source).toBe("community");
      expect(r.entry.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      if (r.entry.transport === "remote") expect("url" in r.entry.server && r.entry.server.url).toMatch(/^https:\/\//);
      if (r.entry.transport === "stdio" && "command" in r.entry.server) {
        expect(["npx", "uvx"]).toContain(r.entry.server.command);
        expect(r.entry.server.version).not.toMatch(/[\^~*<>]|latest/);
      }
    }
    expect(new Set(page.results.map((r) => r.entry.id)).size).toBe(page.results.length);
  });

  it("maps headers with a `Bearer {x}` template to a secret token input with its prefix", async () => {
    routes.set("/v0.1/servers", json(fixture("search-github.json")));
    const page = await searchRegistry("github", undefined, { base });
    const smithery = page.results.find((r) => r.ref.name === "ai.smithery/smithery-ai-github");
    if (smithery) {
      expect(smithery.entry.auth).toBe("token");
      expect(smithery.inputs).toContainEqual(
        expect.objectContaining({ name: "Authorization", as: "header", secret: true, prefix: "Bearer " }),
      );
    }
    expect(page.nextCursor).not.toBeNull();
  });

  it("an npm package becomes a pinned npx command; secret env vars are token inputs", () => {
    const r = mapServer(JSON.parse(fixture("supabase-0.14.0.json")));
    expect(r).not.toBeNull();
    // Supabase lists a remote first: the vendor-run server wins (ADR 0023 §1).
    expect(r!.entry.transport).toBe("remote");
    const parsed = JSON.parse(fixture("supabase-0.14.0.json"));
    delete parsed.server.remotes;
    const stdio = mapServer(parsed)!;
    expect(stdio.entry.server).toEqual({
      package: "@supabase/mcp-server-supabase",
      version: "0.14.0",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase@0.14.0"],
    });
    expect(stdio.entry.auth).toBe("token");
    expect(stdio.inputs).toContainEqual(
      expect.objectContaining({ name: "SUPABASE_ACCESS_TOKEN", as: "env", secret: true, required: true }),
    );
  });

  it("empty search lists all; 1–2 characters is refused before any request", async () => {
    routes.set("/v0.1/servers", json(fixture("search-filesystem.json")));
    lastUrl = "";
    await expect(searchRegistry("ab", undefined, { base })).rejects.toThrow("query_too_short");
    expect(lastUrl).toBe("");
    const page = await searchRegistry("  ", undefined, { base });
    expect(new URL(lastUrl, base).searchParams.has("search")).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("a body over the size cap, bad JSON, a 500 or a dead server are registry errors, not crashes", async () => {
    routes.set("/v0.1/servers", json("x".repeat(REGISTRY_MAX_BYTES + 10)));
    await expect(searchRegistry("github", undefined, { base })).rejects.toThrow("registry_bad_response");
    routes.set("/v0.1/servers", json("{not json"));
    await expect(searchRegistry("github", undefined, { base })).rejects.toThrow("registry_bad_response");
    routes.set("/v0.1/servers", (res) => res.writeHead(500).end());
    await expect(searchRegistry("github", undefined, { base })).rejects.toThrow("registry_bad_response");
    await expect(searchRegistry("github", undefined, { base: "http://127.0.0.1:1" })).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  it("a server that never answers times out", async () => {
    routes.set("/v0.1/servers", () => undefined);
    await expect(searchRegistry("github", undefined, { base, timeoutMs: 200 })).rejects.toThrow("registry_unreachable");
  });

  it("getRegistryServer re-reads the exact version and refuses a mismatch", async () => {
    routes.set("/v0.1/servers/com.supabase%2Fmcp/versions/0.14.0", json(fixture("supabase-0.14.0.json")));
    const r = await getRegistryServer({ name: "com.supabase/mcp", version: "0.14.0" }, { base });
    expect(r.entry.id).toBe("com-supabase-mcp");
    routes.set("/v0.1/servers/com.supabase%2Fmcp/versions/9.9.9", json(fixture("supabase-0.14.0.json")));
    await expect(getRegistryServer({ name: "com.supabase/mcp", version: "9.9.9" }, { base })).rejects.toThrow(
      "not_found",
    );
    await expect(getRegistryServer({ name: "nope/x", version: "1.0.0" }, { base })).rejects.toThrow("not_found");
  });
});

describe("untrusted registry fields", () => {
  const server = (o: Record<string, unknown>) => ({
    server: { name: "io.github.x/y", version: "1.0.0", description: "d", ...o },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
  });
  const remote = (url: string, headers?: unknown[]) => server({ remotes: [{ type: "streamable-http", url, headers }] });

  it("only HTTPS (or HTTP to this computer) URLs, no credentials, no templates", () => {
    expect(mapServer(remote("http://evil.example/mcp"))).toBeNull();
    expect(mapServer(remote("https://user:pw@evil.example/mcp"))).toBeNull();
    expect(mapServer(remote("https://{tenant}.example.com/mcp"))).toBeNull();
    expect(mapServer(remote("javascript:alert(1)"))).toBeNull();
    expect(mapServer(remote("https://ok.example/mcp"))?.entry.auth).toBe("none");
    expect(safeRemoteUrl("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp");
    expect(safeRemoteUrl("http://127.0.0.1.evil.example/mcp")).toBeNull();
  });

  it("SSE remotes, unpinned or ranged versions, unknown package types and inactive servers are skipped", () => {
    expect(mapServer(server({ remotes: [{ type: "sse", url: "https://ok.example/sse" }] }))).toBeNull();
    const pkg = (p: Record<string, unknown>) =>
      server({ packages: [{ registryType: "npm", identifier: "pkg", transport: { type: "stdio" }, ...p }] });
    expect(mapServer(pkg({ version: "^1.0.0" }))).toBeNull();
    expect(mapServer(pkg({}))).toBeNull();
    expect(mapServer(pkg({ version: "1.0.0", registryType: "oci" }))).toBeNull();
    expect(mapServer(pkg({ version: "1.0.0", identifier: "pkg; rm -rf /" }))).toBeNull();
    expect(mapServer(pkg({ version: "1.0.0" }))?.entry.server).toMatchObject({ args: ["-y", "pkg@1.0.0"] });
    expect(
      mapServer({
        ...pkg({ version: "1.0.0" }),
        _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
      }),
    ).toBeNull();
  });

  it("required arguments we can't ask for, injected args, or a header template we can't fill skip the server", () => {
    const pkg = (packageArguments: unknown[]) =>
      server({
        packages: [
          { registryType: "pypi", identifier: "mcp-x", version: "2.0", transport: { type: "stdio" }, packageArguments },
        ],
      });
    expect(mapServer(pkg([{ type: "positional", isRequired: true }]))).toBeNull();
    expect(mapServer(pkg([{ type: "positional", value: "a\nb" }]))).toBeNull();
    expect(mapServer(pkg([{ type: "named", name: "--port", value: "8080" }]))?.entry.server).toMatchObject({
      command: "uvx",
      args: ["mcp-x==2.0", "--port", "8080"],
    });
    expect(mapServer(remote("https://ok.example/mcp", [{ name: "X-Key", value: "{a}-{b}" }]))).toBeNull();
    expect(mapServer(remote("https://ok.example/mcp", [{ name: "Bad Header", isSecret: true }]))).toBeNull();
  });

  it("control and bidi characters are stripped from names and descriptions; long text is capped", () => {
    const r = mapServer(
      server({
        title: "Git‮Hub\u0007",
        description: "x".repeat(5000),
        remotes: [{ type: "streamable-http", url: "https://ok.example/mcp" }],
      }),
    )!;
    expect(r.entry.name).toBe("Git Hub");
    expect(r.entry.description.length).toBeLessThanOrEqual(300);
  });

  it("registry ids are safe slugs", () => {
    expect(registryId("io.github.Foo/Bar_Baz")).toBe("io-github-foo-bar-baz");
    expect(registryId("../../etc")).toBe("etc");
    expect(registryId("a".repeat(200))).toHaveLength(64);
  });
});

describe("probeRemoteAuth", () => {
  it("401 means OAuth, other answers mean open, nothing means unreachable", async () => {
    routes.set("POST /oauth", (res) =>
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' }).end(),
    );
    routes.set("POST /open", json('{"jsonrpc":"2.0","id":1,"result":{}}'));
    expect(await probeRemoteAuth(`${base}/oauth`)).toBe("oauth");
    expect(await probeRemoteAuth(`${base}/open`)).toBe("open");
    expect(await probeRemoteAuth("http://127.0.0.1:1/mcp", { timeoutMs: 500 })).toBe("unreachable");
  });
});

// Real network: the live registry and a live vendor server. Skipped when this machine is offline.
const online = await fetch(`${REGISTRY_BASE}/v0.1/health`, { signal: AbortSignal.timeout(5000) }).then(
  (r) => r.ok,
  () => false,
);
describe.skipIf(!online)("live MCP Registry", () => {
  it("searches the real registry, follows its cursor, and re-reads one server", async () => {
    const first = await searchRegistry("filesystem", undefined, { limit: 5 });
    expect(first.results.length + first.skipped).toBeGreaterThan(0);
    expect(first.nextCursor).not.toBeNull();
    const second = await searchRegistry("filesystem", first.nextCursor!, { limit: 5 });
    const firstIds = new Set(first.results.map((r) => r.ref.name));
    expect(second.results.some((r) => firstIds.has(r.ref.name))).toBe(false);
    const one = first.results[0] ?? second.results[0];
    if (one) expect((await getRegistryServer(one.ref)).ref).toEqual(one.ref);
  }, 30_000);

  it("Linear's official server answers 401 (OAuth or a token), as connectors.yaml says", async () => {
    expect(await probeRemoteAuth("https://mcp.linear.app/mcp")).toBe("oauth");
  }, 20_000);
});
