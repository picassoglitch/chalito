import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretStore, type SecretStore } from "../src/secrets.js";
import { EncryptedFileSecretStore } from "../src/secrets-file.js";
import {
  connectorSecretName,
  ConnectorStore,
  customRemote,
  customStdio,
  resolveCommand,
} from "../src/connections/store.js";
import { connectionSearchHandlers, connectionsSearchFeature } from "../src/connections/ipc.js";
import { VerifiedConnectors, catalogEntry } from "../src/connections/catalog.js";
import type { InputSpec } from "../src/connections/catalog.js";
import type { ConnectorEntry } from "../src/connections/types.js";

// Never the real ~/.chalito or keychain: every test gets its own HOME and an in-memory or file keychain.
let home = "";
let dir = "";
const realHome = process.env.HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chalito-connections-"));
  process.env.HOME = home;
  dir = join(home, ".chalito");
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const token: InputSpec = { name: "Authorization", as: "header", secret: true, required: true, prefix: "Bearer " };
const community: ConnectorEntry = {
  id: "io-github-x-y",
  name: "Y",
  description: "d",
  source: "community",
  transport: "remote",
  server: { url: "https://y.example/mcp" },
  auth: "token",
};
const verified = catalogEntry(new VerifiedConnectors().get("github")!);

describe("ConnectorStore", () => {
  it("round-trips install → list → uninstall in ~/.chalito/connectors.json, secrets only in the keychain", async () => {
    const secrets = new MemorySecretStore();
    const store = new ConnectorStore({ dir, secrets, now: () => 1234 });
    const installed = await store.install({
      entry: verified,
      inputs: [token],
      values: { Authorization: "ghp_secret" },
      confirmed: true,
      warningAccepted: false,
    });
    expect(installed).toMatchObject({ id: "github", source: "verified", installedAt: 1234, confirmedWarning: false });
    const text = readFileSync(join(dir, "connectors.json"), "utf8");
    expect(text).not.toContain("ghp_secret");
    expect(JSON.parse(text)).toMatchObject({
      v: 1,
      installed: [{ id: "github" }],
      secrets: { github: [{ name: "Authorization", as: "header" }] },
    });
    if (process.platform !== "win32") expect(statSync(join(dir, "connectors.json")).mode & 0o777).toBe(0o600);
    expect(await secrets.get("chalito.connector.github.Authorization")).toBe("Bearer ghp_secret");
    // A fresh store (another process) reads the same file.
    expect(new ConnectorStore({ dir, secrets }).list().map((c) => c.id)).toEqual(["github"]);
    await store.uninstall("github");
    expect(store.list()).toEqual([]);
    expect(secrets.values.size).toBe(0);
    await expect(store.uninstall("github")).rejects.toThrow("not_installed");
  });

  it("works with the real encrypted-file keychain too", async () => {
    const secrets: SecretStore = new EncryptedFileSecretStore({
      path: join(dir, "secrets.enc"),
      passphrase: "test passphrase for connectors",
      kdf: { opslimit: 1, memlimit: 8192 },
    });
    const store = new ConnectorStore({ dir, secrets });
    await store.install({
      entry: community,
      inputs: [token],
      values: { Authorization: "abc" },
      confirmed: true,
      warningAccepted: true,
    });
    expect(await secrets.get(connectorSecretName(community.id, "Authorization"))).toBe("Bearer abc");
    await store.uninstall(community.id);
    expect(await secrets.get(connectorSecretName(community.id, "Authorization"))).toBeNull();
  });

  it("community and custom need the unverified warning once; every source needs the one confirmation", async () => {
    const store = new ConnectorStore({ dir, secrets: new MemorySecretStore() });
    const base = { inputs: [token], values: { Authorization: "abc" } };
    await expect(store.install({ ...base, entry: community, confirmed: true, warningAccepted: false })).rejects.toThrow(
      "warning_required",
    );
    await expect(
      store.install({ ...base, entry: { ...community, source: "custom" }, confirmed: true, warningAccepted: false }),
    ).rejects.toThrow("warning_required");
    await expect(store.install({ ...base, entry: verified, confirmed: false, warningAccepted: true })).rejects.toThrow(
      "confirm_required",
    );
    const c = await store.install({ ...base, entry: community, confirmed: true, warningAccepted: true });
    expect(c.confirmedWarning).toBe(true);
    await expect(store.install({ ...base, entry: community, confirmed: true, warningAccepted: true })).rejects.toThrow(
      "already_installed",
    );
  });

  it("held (OAuth) entries refuse install", async () => {
    const store = new ConnectorStore({ dir, secrets: new MemorySecretStore() });
    const slack = catalogEntry(new VerifiedConnectors().get("slack")!);
    await expect(
      store.install({ entry: slack, inputs: [], values: {}, confirmed: true, warningAccepted: true }),
    ).rejects.toThrow("held_oauth");
    await expect(
      store.install({
        entry: { ...community, auth: "oauth" },
        inputs: [],
        values: {},
        confirmed: true,
        warningAccepted: true,
      }),
    ).rejects.toThrow("held_oauth");
    expect(store.list()).toEqual([]);
  });

  it("refuses missing, unknown or line-breaking values", async () => {
    const store = new ConnectorStore({ dir, secrets: new MemorySecretStore() });
    const go = (values: Record<string, string>) =>
      store.install({ entry: community, inputs: [token], values, confirmed: true, warningAccepted: true });
    await expect(go({})).rejects.toThrow("missing_input");
    await expect(go({ Authorization: "  " })).rejects.toThrow("missing_input");
    await expect(go({ Authorization: "a", Other: "b" })).rejects.toThrow("bad_input");
    await expect(go({ Authorization: "abc\r\nX-Evil: 1" })).rejects.toThrow("bad_input");
  });

  it("a keychain failure leaves nothing behind", async () => {
    const mem = new MemorySecretStore();
    let calls = 0;
    const flaky: SecretStore = {
      get: (n) => mem.get(n),
      delete: (n) => mem.delete(n),
      set: async (n, v) => {
        if (++calls === 2) throw new Error("locked");
        await mem.set(n, v);
      },
    };
    const store = new ConnectorStore({ dir, secrets: flaky });
    const two: InputSpec[] = [
      { name: "A", as: "env", secret: true, required: true },
      { name: "B", as: "env", secret: true, required: true },
    ];
    await expect(
      store.install({
        entry: community,
        inputs: two,
        values: { A: "1", B: "2" },
        confirmed: true,
        warningAccepted: true,
      }),
    ).rejects.toThrow("keychain");
    expect(mem.values.size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("a corrupt file is reported, never overwritten", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "connectors.json"), "{ nope");
    const store = new ConnectorStore({ dir, secrets: new MemorySecretStore() });
    expect(() => store.list()).toThrow("state_corrupt");
    await expect(
      store.install({
        entry: verified,
        inputs: [token],
        values: { Authorization: "x" },
        confirmed: true,
        warningAccepted: false,
      }),
    ).rejects.toThrow("state_corrupt");
    expect(readFileSync(join(dir, "connectors.json"), "utf8")).toBe("{ nope");
  });

  it("concurrent installs both land", async () => {
    const store = new ConnectorStore({ dir, secrets: new MemorySecretStore() });
    const a = { ...community, id: "a-one" };
    const b = { ...community, id: "b-two" };
    await Promise.all(
      [a, b].map((entry) =>
        store.install({
          entry,
          inputs: [token],
          values: { Authorization: "x" },
          confirmed: true,
          warningAccepted: true,
        }),
      ),
    );
    expect(
      store
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["a-one", "b-two"]);
  });
});

describe("add your own", () => {
  it("by URL: HTTPS only, custom source, optional bearer token", () => {
    expect(() => customRemote({ name: "Mine", url: "http://example.com/mcp", token: false })).toThrow("bad_url");
    const r = customRemote({ name: "My Server", url: "https://mine.example/mcp", token: true });
    expect(r.entry).toMatchObject({ id: "custom-my-server", source: "custom", transport: "remote", auth: "token" });
    expect(r.inputs[0]).toMatchObject({ name: "Authorization", prefix: "Bearer " });
    expect(() => customRemote({ name: "\u0007", url: "https://mine.example/mcp", token: false })).toThrow("bad_input");
  });

  it("by command: resolves on PATH and pins the executable's sha256", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const exe = join(bin, "my-mcp");
    writeFileSync(exe, "#!/bin/sh\necho hi\n");
    chmodSync(exe, 0o755);
    const r = await customStdio(
      { name: "Local", command: "my-mcp", args: ["--stdio"], env: ["MY_TOKEN"] },
      { PATH: bin },
    );
    expect(r.entry.server).toMatchObject({ command: exe, args: ["--stdio"], version: "local" });
    expect((r.entry.server as { integrity: string }).integrity).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(r.inputs).toEqual([{ name: "MY_TOKEN", as: "env", secret: true, required: true }]);
    await expect(
      customStdio({ name: "X", command: "nope-not-here", args: [], env: [] }, { PATH: bin }),
    ).rejects.toThrow("command_not_found");
    await expect(customStdio({ name: "X", command: "./rel", args: [], env: [] }, { PATH: bin })).rejects.toThrow(
      "command_not_found",
    );
    await expect(customStdio({ name: "X", command: "my-mcp", args: ["a\nb"], env: [] }, { PATH: bin })).rejects.toThrow(
      "bad_input",
    );
    expect(resolveCommand(exe)).toBe(exe);
  });
});

describe("Conexiones IPC (real local servers, temp HOME)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const page = readFileSync(new URL("./fixtures/registry/search-github.json", import.meta.url), "utf8");
    const supabase = readFileSync(new URL("./fixtures/registry/supabase-0.14.0.json", import.meta.url), "utf8");
    const open = (url: string) => ({
      server: {
        name: "io.example/open",
        version: "1.0.0",
        description: "open",
        remotes: [{ type: "streamable-http", url }],
      },
    });
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const send = (b: string) => res.writeHead(200, { "content-type": "application/json" }).end(b);
      if (path === "/v0.1/servers") return send(page);
      if (path === "/v0.1/servers/com.supabase%2Fmcp/versions/0.14.0") return send(supabase);
      if (path === "/v0.1/servers/io.example%2Fopen/versions/1.0.0")
        return send(JSON.stringify(open(`${base}/mcp-open`)));
      if (path === "/v0.1/servers/io.example%2Foauth/versions/1.0.0")
        return send(JSON.stringify({ server: { ...open(`${base}/mcp-oauth`).server, name: "io.example/oauth" } }));
      if (path === "/mcp-oauth") return res.writeHead(401, { "www-authenticate": "Bearer" }).end();
      if (path === "/mcp-open") return send('{"jsonrpc":"2.0","id":1,"result":{}}');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const setup = (registryBase = base) => {
    const audit: [string, Record<string, unknown>][] = [];
    const secrets = new MemorySecretStore();
    const h = connectionSearchHandlers(
      connectionsSearchFeature({ dir, secrets, audit: (t, m) => audit.push([t, m]), registry: { base: registryBase } }),
    );
    return { h, audit, secrets };
  };

  it("search shows matching verified ones plus registry results; offline keeps the verified ones", async () => {
    const { h } = setup();
    const r = (await h.connectionsSearch!({ q: "github" })) as {
      verified: { entry: ConnectorEntry }[];
      community: unknown[];
      nextCursor: string;
      error: null;
    };
    expect(r.verified.map((v) => v.entry.id)).toEqual(["github"]);
    expect(r.community.length).toBeGreaterThan(0);
    expect(r.nextCursor).toBeTruthy();
    const next = (await h.connectionsSearch!({ q: "github", cursor: r.nextCursor })) as { verified: unknown[] };
    expect(next.verified).toEqual([]);
    const offline = (await setup("http://127.0.0.1:1").h.connectionsSearch!({ q: "github" })) as {
      verified: unknown[];
      error: string;
    };
    expect(offline.verified).toHaveLength(1);
    expect(offline.error).toBe("registry_unreachable");
  });

  it("installs a registry server the agent re-reads itself, audits it, and uninstalls it", async () => {
    const { h, audit, secrets } = setup();
    const openRef = { kind: "registry", name: "io.example/open", version: "1.0.0" };
    await expect(
      h.connectionsInstall!({ ref: openRef, values: {}, confirmed: true, warningAccepted: false }),
    ).rejects.toThrow("warning_required");
    const out = (await h.connectionsInstall!({ ref: openRef, values: {}, confirmed: true, warningAccepted: true })) as {
      installed: ConnectorEntry;
    };
    expect(out.installed).toMatchObject({ id: "io-example-open", source: "community" });
    expect(audit).toContainEqual([
      "connector.installed",
      { id: "io-example-open", source: "community", transport: "remote", via: "panel" },
    ]);
    const list = (await h.connectionsInstalled!(null)) as { installed: { id: string }[] };
    expect(list.installed.map((c) => c.id)).toEqual(["io-example-open"]);
    await h.connectionsUninstall!({ id: "io-example-open" });
    expect(audit.at(-1)?.[0]).toBe("connector.uninstalled");
    expect(secrets.values.size).toBe(0);
  });

  it("a remote that answers 401 is held as OAuth: check says so and install refuses", async () => {
    const { h } = setup();
    const ref = { kind: "registry", name: "io.example/oauth", version: "1.0.0" };
    expect(((await h.connectionsCheck!({ ref })) as { held: string }).held).toBe("oauth");
    await expect(h.connectionsInstall!({ ref, values: {}, confirmed: true, warningAccepted: true })).rejects.toThrow(
      "held_oauth",
    );
  });

  it("verified installs come from the catalog; held verified ones refuse; unknown ids fail", async () => {
    const { h, secrets } = setup();
    const out = (await h.connectionsInstall!({
      ref: { kind: "verified", id: "linear" },
      values: { Authorization: "lin_api_x" },
      confirmed: true,
      warningAccepted: false,
    })) as { installed: ConnectorEntry };
    expect(out.installed).toMatchObject({ source: "verified", server: { url: "https://mcp.linear.app/mcp" } });
    expect(await secrets.get("chalito.connector.linear.Authorization")).toBe("Bearer lin_api_x");
    await expect(
      h.connectionsInstall!({
        ref: { kind: "verified", id: "slack" },
        values: {},
        confirmed: true,
        warningAccepted: true,
      }),
    ).rejects.toThrow("held_oauth");
    await expect(
      h.connectionsInstall!({
        ref: { kind: "verified", id: "nope" },
        values: {},
        confirmed: true,
        warningAccepted: true,
      }),
    ).rejects.toThrow("unknown_connector");
    await expect(h.connectionsInstall!({ ref: { kind: "verified", id: "github" }, confirmed: true })).rejects.toThrow(
      "bad_params",
    );
  });

  it("add your own URL: probes, needs the warning, stored as custom", async () => {
    const { h } = setup();
    const ref = { kind: "url", name: "Mine", url: `http://localhost:${new URL(base).port}/mcp-open`, token: false };
    const out = (await h.connectionsInstall!({ ref, values: {}, confirmed: true, warningAccepted: true })) as {
      installed: ConnectorEntry;
    };
    expect(out.installed).toMatchObject({ id: "custom-mine", source: "custom", confirmedWarning: true });
    await expect(
      h.connectionsInstall!({
        ref: { ...ref, name: "Dead", url: "http://localhost:1/mcp" },
        values: {},
        confirmed: true,
        warningAccepted: true,
      }),
    ).rejects.toThrow("unreachable");
  });

  it("the vendor's own registry entry isn't repeated as Comunidad when it's already Verificado", async () => {
    const dup = {
      servers: [
        {
          server: {
            name: "io.github.github/github-mcp-server",
            version: "2.0.3",
            remotes: [{ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" }],
          },
        },
        {
          server: {
            name: "io.example/other",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://other.example/mcp" }],
          },
        },
      ],
      metadata: { count: 2 },
    };
    const s2 = createServer((_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(dup)),
    );
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    try {
      const { h } = setup(`http://127.0.0.1:${(s2.address() as AddressInfo).port}`);
      const r = (await h.connectionsSearch!({ q: "github" })) as { community: { entry: ConnectorEntry }[] };
      expect(r.community.map((c) => c.entry.id)).toEqual(["io-example-other"]);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });

  it("without the feature every call answers unavailable", async () => {
    await expect(connectionSearchHandlers(null).connectionsSearch!({ q: "x" })).rejects.toThrow("unavailable");
  });
});
