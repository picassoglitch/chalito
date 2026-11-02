import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { duplexPair, PassThrough, type Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  randomNonce,
  revokeAllServerEntry,
  revokeBundleChallenge,
  signEnvelope,
  stepUpBodyHash,
} from "@chalito/crypto";
import { main } from "../src/cli.js";
import { codeService } from "../src/code/service.js";
import { startCodeServer } from "../src/code/server.js";
import { ConnectorSessions } from "../src/connections/gate.js";
import { CONNECTORS_FILE, readInstalled } from "../src/connections/installed.js";
import { runConnectionsMcp } from "../src/connections/mcp.js";
import { ConnectionsProxy, type ConnectorGate } from "../src/connections/proxy.js";
import { capText, slugFor, toolRisk } from "../src/connections/risk.js";
import { allowedRemoteUrl, sseMessages } from "../src/connections/transport.js";
import type { InstalledConnector } from "../src/connections/types.js";
import { backoffMs, secretName } from "../src/connections/upstream.js";
import { MemorySecretStore } from "../src/secrets.js";
import { agentFor, HOME, OWNER, tempDir, waitFor } from "./rc-harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/connections/stdio-mcp-server.mjs", import.meta.url));
const ALLOW: ConnectorGate = async () => ({ allow: true, reason: "test" });

const stdio = (id: string, over: Partial<InstalledConnector> = {}, extra: string[] = []): InstalledConnector => ({
  id,
  name: `Fixture ${id}`,
  description: "fixture",
  source: "verified",
  transport: "stdio",
  server: { package: "fixture", version: "1.0.0", command: process.execPath, args: [FIXTURE, ...extra] },
  auth: "none",
  installedAt: 1,
  confirmedWarning: false,
  ...over,
});

const install = (dir: string, installed: InstalledConnector[]) =>
  writeFileSync(join(dir, CONNECTORS_FILE), JSON.stringify({ v: 1, installed }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const proxies: ConnectionsProxy[] = [];
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.close();
});

const rig = (
  o: {
    gate?: ConnectorGate;
    secrets?: MemorySecretStore;
    env?: NodeJS.ProcessEnv;
    restartMs?: number;
    cap?: number;
    callTimeoutMs?: number;
  } = {},
) => {
  const dir = tempDir("chalito-conn-");
  const audits: { type: string; meta: Record<string, unknown> }[] = [];
  const secrets = o.secrets ?? new MemorySecretStore();
  const proxy = new ConnectionsProxy({
    dir,
    secrets,
    gate: o.gate ?? ALLOW,
    audit: (type, meta) => void audits.push({ type, meta }),
    env: o.env ?? { PATH: process.env.PATH },
    ...(o.cap ? { resultCap: o.cap } : {}),
    ...(o.callTimeoutMs ? { callTimeoutMs: o.callTimeoutMs } : {}),
    ...(o.restartMs !== undefined
      ? {
          setTimer: (fn: () => void) => {
            const t = setTimeout(fn, o.restartMs);
            return { clear: () => clearTimeout(t) };
          },
        }
      : {}),
  });
  proxies.push(proxy);
  return { dir, audits, secrets, proxy };
};

const signal = () => new AbortController().signal;
const client = { key: "k1", app: "claude-code" };
const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");

describe("connections proxy: a real stdio MCP server", () => {
  it("lists every tool namespaced, paginated, labelled and risk-stamped; starts only on first use", async () => {
    const { dir, proxy } = rig();
    install(dir, [stdio("io.github.acme/fixture")]);
    expect(proxy.running()).toEqual([]);
    const tools = await proxy.listTools();
    const names = tools.map((t) => t.name).sort();
    // "bad name!" is not a valid tool name: it is left out, never mangled.
    expect(names).toEqual(
      ["big", "crash", "delete_repo", "echo", "fail", "fail_secret", "garbage", "show_env", "sleep"].map(
        (t) => `io-github-acme-fixture__${t}`,
      ),
    );
    const echo = tools.find((t) => t.name.endsWith("__echo"))!;
    expect(echo.description.startsWith("[Verificado · Fixture io.github.acme/fixture]")).toBe(true);
    expect(echo.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // A server's read-only hint can't make a destructive name safe.
    expect(tools.find((t) => t.name.endsWith("__delete_repo"))!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(proxy.running()).toHaveLength(1);
  });

  it("calls a tool and returns its text as quoted data", async () => {
    const { dir, proxy } = rig();
    install(dir, [stdio("fx")]);
    const r = await proxy.callTool("fx__echo", { text: "hola <b>" }, client, signal());
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe(
      '<connector_data source="fx" tool="echo" trust="Verificado">"echo:hola \\u003cb\\u003e"</connector_data>',
    );
  });

  it("a server's error text can't close the quoted frame", async () => {
    const { dir, proxy } = rig();
    install(dir, [stdio("fx")]);
    const r = await proxy.callTool("fx__fail", {}, client, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r).match(/<\/connector_data>/g)).toHaveLength(1);
  });

  it("community tools are write/MED at least, whatever the server's hints say", async () => {
    const stamps: unknown[] = [];
    const { dir, proxy } = rig({ gate: async (c) => (stamps.push(c.stamp), { allow: true, reason: "t" }) });
    install(dir, [stdio("fx", { source: "community", confirmedWarning: true })]);
    const tools = await proxy.listTools();
    expect(tools.find((t) => t.name === "fx__echo")!.description.startsWith("[Comunidad")).toBe(true);
    await proxy.callTool("fx__echo", { text: "x" }, client, signal());
    expect(stamps).toEqual([{ connectorId: "fx", source: "community", tool: "echo", tier: "write", risk: "MED" }]);
  });

  it("never runs a held (OAuth) or an unconfirmed community connector", async () => {
    const { dir, proxy } = rig();
    install(dir, [
      stdio("held", { held: "oauth", auth: "oauth" }),
      stdio("unconfirmed", { source: "community", confirmedWarning: false }),
      stdio("custom", { source: "custom", confirmedWarning: false }),
    ]);
    expect(await proxy.listTools()).toEqual([]);
    expect(proxy.running()).toEqual([]);
    const r = await proxy.callTool("unconfirmed__echo", {}, client, signal());
    expect(r.isError).toBe(true);
  });

  it("a gate deny never reaches the server and is audited as a deny", async () => {
    const calls = join(tempDir("chalito-calls-"), "calls.log");
    const { dir, proxy, audits } = rig({ gate: async () => ({ allow: false, reason: "denied" }) });
    install(dir, [stdio("fx", {}, ["--calls", calls])]);
    const r = await proxy.callTool("fx__show_env", { name: "PATH" }, client, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("denied");
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
    expect(audits.find((a) => a.type === "connector.call")!.meta).toMatchObject({
      connector: "fx",
      tool: "show_env",
      decision: "deny",
      reason: "denied",
    });
  });

  it("caps a large result at 64 KB on a character boundary and says so", async () => {
    const { dir, proxy, audits } = rig();
    install(dir, [stdio("fx")]);
    const r = await proxy.callTool("fx__big", { n: 300_000 }, client, signal());
    const text = textOf(r);
    expect(text).toContain("[Chalito cut this result at 65536 of 300000 bytes.]");
    const inner = JSON.parse(text.slice(text.indexOf(">") + 1, text.indexOf("</connector_data>"))) as string;
    expect(Buffer.byteLength(inner)).toBeLessThanOrEqual(65536);
    expect(inner).not.toContain("�");
    expect(audits.find((a) => a.type === "connector.call")!.meta).toMatchObject({
      truncated: true,
      resultBytes: 300_000,
    });
  });

  it("audit rows hold hashes and sizes, never the arguments or the result", async () => {
    const { dir, proxy, audits } = rig();
    install(dir, [stdio("fx")]);
    await proxy.callTool("fx__echo", { text: "PLAINTEXT-ARG-7731" }, client, signal());
    const row = audits.find((a) => a.type === "connector.call")!.meta;
    expect(row.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.argsBytes).toBe(JSON.stringify({ text: "PLAINTEXT-ARG-7731" }).length);
    expect(JSON.stringify(audits)).not.toContain("PLAINTEXT-ARG-7731");
  });

  it("restarts a crashed server with backoff and keeps working", async () => {
    const pids = tempDir("chalito-pid-");
    const pidfile = join(pids, "pid");
    const { dir, proxy, audits } = rig({ restartMs: 20 });
    install(dir, [stdio("fx", {}, ["--pidfile", pidfile])]);
    await proxy.listTools();
    const first = Number(readFileSync(pidfile, "utf8"));
    const r = await proxy.callTool("fx__crash", {}, client, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("connector_crashed");
    await waitFor(() => audits.some((a) => a.type === "connector.restarted"), 5000);
    const second = Number(readFileSync(pidfile, "utf8"));
    expect(second).not.toBe(first);
    expect(audits.find((a) => a.type === "connector.crashed")!.meta).toEqual({ connector: "fx", attempt: 1 });
    expect(textOf(await proxy.callTool("fx__echo", { text: "back" }, client, signal()))).toContain("echo:back");
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(6)).toBe(30_000);
  });

  it("kills its servers when the agent stops, and stops one that was uninstalled", async () => {
    const pids = tempDir("chalito-pid-");
    const { dir, proxy } = rig();
    install(dir, [stdio("a", {}, ["--pidfile", join(pids, "a")]), stdio("b", {}, ["--pidfile", join(pids, "b")])]);
    await proxy.listTools();
    const a = Number(readFileSync(join(pids, "a"), "utf8"));
    const b = Number(readFileSync(join(pids, "b"), "utf8"));
    install(dir, [stdio("b", {}, ["--pidfile", join(pids, "b")])]);
    expect((await proxy.listTools()).every((t) => t.name.startsWith("b__"))).toBe(true);
    await waitFor(() => !alive(a), 5000);
    await proxy.close();
    await waitFor(() => !alive(b), 5000);
  });
});

describe("connections proxy: secrets", () => {
  it("passes the keychain token in the server's env, scrubs it from results, never logs it; agent env stays out", async () => {
    const secrets = new MemorySecretStore();
    const token = "ghp_SUPERSECRET_9921";
    await secrets.set(secretName("fx", "FIXTURE_TOKEN"), token);
    const { dir, proxy, audits } = rig({ secrets, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-agent" } });
    install(dir, [stdio("fx", { auth: "token", secretEnv: ["FIXTURE_TOKEN"] })]);
    const got = textOf(await proxy.callTool("fx__show_env", { name: "FIXTURE_TOKEN" }, client, signal()));
    expect(got).toContain("value=[secret]");
    expect(got).not.toContain(token);
    expect(textOf(await proxy.callTool("fx__show_env", { name: "ANTHROPIC_API_KEY" }, client, signal()))).toContain(
      "value=unset",
    );
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("a token connector without its keychain entry stays down and is left out", async () => {
    const { dir, proxy, audits } = rig();
    install(dir, [stdio("fx", { auth: "token", secretEnv: ["FIXTURE_TOKEN"] })]);
    expect(await proxy.listTools()).toEqual([]);
    expect(audits).toContainEqual({
      type: "connector.unavailable",
      meta: { connector: "fx", error: "connector_needs_token" },
    });
  });
});

describe("connections proxy: a remote streamable-HTTP server", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const body = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => resolve(JSON.parse(raw) as Record<string, unknown>));
    });

  it("sends the keychain token as a bearer header, keeps the MCP session, reads SSE replies", async () => {
    const seen: { auth?: string; session?: string; method: string }[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") return res.writeHead(200).end();
      const msg = await body(req);
      seen.push({
        auth: req.headers.authorization,
        session: req.headers["mcp-session-id"] as string,
        method: String(msg.method),
      });
      if (req.headers.authorization !== "Bearer remote-token-123") return res.writeHead(401).end();
      if (msg.id === undefined) return res.writeHead(202).end();
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize")
        return res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" })
          .end(
            JSON.stringify(
              reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "r", version: "1" } }),
            ),
          );
      if (msg.method === "tools/list")
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(reply({ tools: [{ name: "search", inputSchema: { type: "object" } }] })));
      const params = msg.params as { arguments: { q: string } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
      );
      res.end(
        `event: message\ndata: ${JSON.stringify(reply({ content: [{ type: "text", text: `found ${params.arguments.q}` }] }))}\n\n`,
      );
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const secrets = new MemorySecretStore();
    await secrets.set(secretName("remote", "token"), "remote-token-123");
    const { dir, proxy, audits } = rig({ secrets });
    install(dir, [
      {
        id: "remote",
        name: "Remote",
        description: "",
        source: "verified",
        transport: "remote",
        server: { url: `http://127.0.0.1:${port}/mcp` },
        auth: "token",
        installedAt: 1,
        confirmedWarning: false,
      },
    ]);
    expect((await proxy.listTools()).map((t) => t.name)).toEqual(["remote__search"]);
    expect(textOf(await proxy.callTool("remote__search", { q: "issues" }, client, signal()))).toContain("found issues");
    expect(seen.every((s) => s.auth === "Bearer remote-token-123")).toBe(true);
    expect(seen.filter((s) => s.method !== "initialize").every((s) => s.session === "sess-1")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("remote-token-123");
  });

  it("refuses plain-HTTP servers that aren't on this machine", async () => {
    const { dir, proxy, audits } = rig();
    install(dir, [
      {
        id: "insecure",
        name: "Insecure",
        description: "",
        source: "community",
        transport: "remote",
        server: { url: "http://example.com/mcp" },
        auth: "none",
        installedAt: 1,
        confirmedWarning: true,
      },
    ]);
    expect(await proxy.listTools()).toEqual([]);
    expect(audits).toContainEqual({
      type: "connector.unavailable",
      meta: { connector: "insecure", error: "connector_bad_url" },
    });
    expect(allowedRemoteUrl("https://mcp.example.com/x")).toBe(true);
    expect(allowedRemoteUrl("https://user:pw@mcp.example.com/x")).toBe(false);
    expect(allowedRemoteUrl("http://localhost:3000/mcp")).toBe(true);
  });
});

describe("connections: the AI app's MCP server → code socket → real agent gate", () => {
  const wire = async () => {
    const s = await agentFor();
    const { dir, proxy, audits, secrets } = rig({
      gate: (call) => sessions.gate(call),
    });
    const sessions = new ConnectorSessions({ core: s.core, store: s.store, deviceId: s.self.id, now: Date.now });
    let accept!: (stream: Duplex) => void;
    const code = codeService(
      s.core,
      () => s.policy.get(),
      () => ({ adapters: [], labels: ["chalito"], workspaces: 1 }),
      "local:cli",
      HOME,
    );
    const server = await startCodeServer({
      path: "conn-test",
      platform: "win32",
      code,
      connections: {
        list: () => proxy.listTools(),
        call: (c, name, args, sig) => proxy.callTool(name, args, c, sig),
        closed: (key) => void sessions.end(key),
      },
      listen: (_p, on) => {
        accept = on;
        return { close: () => undefined };
      },
    });
    const input = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    const done = runConnectionsMcp({
      input,
      write: (line) => void replies.push(JSON.parse(line) as Record<string, unknown>),
      path: "conn-test",
      app: "claude-code",
      openPipe: () => {
        const [a, b] = duplexPair();
        accept(b);
        return { ok: true, stream: a };
      },
    });
    let n = 0;
    const send = async (method: string, params: unknown = {}) => {
      const id = ++n;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await waitFor(() => replies.some((r) => r.id === id), 10_000);
      return replies.find((r) => r.id === id)!;
    };
    return { s, dir, proxy, audits, secrets, sessions, input, send, done, server, replies };
  };

  it("a verified read runs at once; a write waits for the phone; a deny stays denied", async () => {
    const w = await wire();
    try {
      install(w.dir, [stdio("fx")]);
      const init = (await w.send("initialize", { protocolVersion: "2025-06-18" })).result as Record<string, unknown>;
      expect(init.serverInfo).toMatchObject({ name: "chalito-connections" });
      const listed = (await w.send("tools/list")).result as { tools: { name: string }[] };
      expect(listed.tools.map((t) => t.name)).toContain("fx__echo");

      const read = (await w.send("tools/call", { name: "fx__echo", arguments: { text: "hi" } })).result as {
        content: { text: string }[];
      };
      expect(read.content[0]!.text).toContain("echo:hi");
      expect(w.s.store.pendingApprovals()).toHaveLength(0);

      const id = 99;
      w.input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fx__show_env", arguments: { name: "PATH" } } })}\n`,
      );
      await waitFor(() => w.s.store.pendingApprovals().length === 1, 10_000);
      const pending = w.s.store.pendingApprovals()[0]!;
      expect(pending.sid.startsWith("connector-")).toBe(true);
      expect(w.s.store.sessions.get(pending.sid)).toMatchObject({
        label: "Conexiones",
        appId: "claude-code",
        control: "approvals",
      });
      expect(pending.risk).toBe("MED");
      await w.s.answer(false);
      await waitFor(() => w.replies.some((r) => r.id === id), 10_000);
      const denied = w.replies.find((r) => r.id === id)!.result as { isError: boolean; content: { text: string }[] };
      expect(denied.isError).toBe(true);
      expect(denied.content[0]!.text).toContain("did not allow");

      const del = 100;
      w.input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: del, method: "tools/call", params: { name: "fx__delete_repo", arguments: {} } })}\n`,
      );
      await waitFor(() => w.s.store.pendingApprovals().length === 1, 10_000);
      // Destructive names need the passkey step-up (HIGH).
      expect(w.s.store.pendingApprovals()[0]!.risk).toBe("HIGH");
      await w.s.answer(true, true);
      await waitFor(() => w.replies.some((r) => r.id === del), 10_000);
      expect(JSON.stringify(w.replies.find((r) => r.id === del)!.result)).toContain("deleted");
      expect(w.audits.filter((a) => a.type === "connector.call").map((a) => [a.meta.tool, a.meta.decision])).toEqual([
        ["echo", "allow"],
        ["show_env", "deny"],
        ["delete_repo", "allow"],
      ]);
    } finally {
      w.input.end();
      await w.done;
      await w.server.close();
      await w.sessions.close();
    }
  });

  it("without a running agent the AI app gets a clear error, not an empty list or a hang", async () => {
    const input = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    const done = runConnectionsMcp({
      input,
      write: (line) => void replies.push(JSON.parse(line) as Record<string, unknown>),
      path: join(tempDir("chalito-nosock-"), "code.sock"),
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x__y" } })}\n`);
    await waitFor(() => replies.length === 2, 5000);
    input.end();
    await done;
    expect(JSON.stringify(replies.find((r) => r.id === 1)!.error)).toContain("isn't running");
    expect(JSON.stringify(replies.find((r) => r.id === 2))).toContain("isn't running");
  });

  it("`chalito-agent connections mcp` refuses an app name that isn't one", async () => {
    let err = "";
    const code = await main(["connections", "mcp", "Bad App!"], {
      out: () => undefined,
      err: (s) => void (err += s),
      tty: { input: new PassThrough(), output: new PassThrough() } as never,
      env: {},
      home: tempDir("chalito-home-"),
      platform: "linux",
      runner: (() => undefined) as never,
      fetch: (() => undefined) as never,
      now: Date.now,
      execPath: process.execPath,
      tmpdir: tempDir("chalito-tmp-"),
    });
    expect(code).toBe(2);
    expect(err).toContain("unknown app");
  });
});

describe("connections: revoke-all (ADR 0020)", () => {
  it("a revoke-all bundle stops every server, deletes its keychain entries and empties the installed list", async () => {
    const pids = tempDir("chalito-pid-");
    const secrets = new MemorySecretStore();
    await secrets.set(secretName("fx", "FIXTURE_TOKEN"), "tok-abcdef");
    await secrets.set(secretName("fx", "token"), "tok-ghijkl");
    const { dir, proxy, audits } = rig({ secrets });
    install(dir, [stdio("fx", { auth: "token", secretEnv: ["FIXTURE_TOKEN"] }, ["--pidfile", join(pids, "fx")])]);
    await proxy.listTools();
    const pid = Number(readFileSync(join(pids, "fx"), "utf8"));
    const a = await agentFor({ connections: proxy });
    const other = "dev_tablet_conn";
    const body: Record<string, unknown> = {
      v: 1,
      cid: "rbc1",
      uid: OWNER,
      targetDeviceId: a.self.id,
      origin: `client:${a.phone.id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: { type: "device.revokeClient", clientDeviceId: other },
    };
    const server = await revokeAllServerEntry({ uid: OWNER, deviceId: a.phone.id, challenge: "srv" });
    const L = [await stepUpBodyHash(body), server];
    const assertion = await a.passkey.stepUp(a.passkeyRef.rpId)(await revokeBundleChallenge(L));
    body.stepUp = { method: "webauthn", at: Date.now(), assertion, bundle: L };
    const env = await signEnvelope("chalito.command.v1", body, a.phone.id, a.phone.sign.secretKey);
    expect(await a.core.handleCommand("rbc1", { env })).toEqual({ ok: true });
    await waitFor(() => !alive(pid), 5000);
    expect(secrets.values.size).toBe(0);
    expect(readInstalled(dir)).toEqual([]);
    expect(audits).toContainEqual({
      type: "connector.revoke_all",
      meta: { count: 1, by: "revoke_all", secretsFailed: 0, unreadable: false },
    });
  });
});

describe("connections helpers", () => {
  it("risk, slugs, caps and SSE parsing", () => {
    const c = stdio("x");
    expect(toolRisk(c, { name: "list_issues", annotations: { readOnlyHint: true } })).toEqual({
      tier: "read",
      risk: "LOW",
    });
    expect(toolRisk(c, { name: "create_issue" })).toEqual({ tier: "write", risk: "MED" });
    expect(toolRisk(c, { name: "send_message", annotations: { readOnlyHint: true } })).toEqual({
      tier: "write",
      risk: "HIGH",
    });
    expect(toolRisk(c, { name: "x", annotations: { destructiveHint: true } })).toEqual({ tier: "write", risk: "HIGH" });
    expect(slugFor("io.github.Some/Very-Long-Server-Name-Here")).toBe("io-github-some-very-long");
    expect(slugFor("///")).toBe("connector");
    expect(capText("ñ".repeat(10), 5)).toEqual({ text: "ññ", bytes: 20, truncated: true });
    expect(sseMessages('data: {"id":1}\n\nevent: x\ndata: nope\n\n')).toEqual([{ id: 1 }]);
  });
});

describe("connections proxy: lifecycle and edge cases", () => {
  it("a stop during the restart backoff never spawns a new server", async () => {
    const pids = tempDir("chalito-pid-");
    const pidfile = join(pids, "pid");
    const { dir, proxy, audits } = rig({ restartMs: 150 });
    install(dir, [stdio("fx", {}, ["--pidfile", pidfile])]);
    await proxy.listTools();
    const first = readFileSync(pidfile, "utf8");
    await proxy.callTool("fx__crash", {}, client, signal());
    await proxy.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(pidfile, "utf8")).toBe(first);
    expect(audits.some((a) => a.type === "connector.restarted")).toBe(false);
  });

  it("kills the whole process group, grandchildren and a server that ignores SIGTERM included", async () => {
    const pids = tempDir("chalito-pid-");
    const { dir, proxy } = rig();
    install(dir, [
      stdio("fx", {}, ["--pidfile", join(pids, "server"), "--spawn-child", join(pids, "child"), "--ignore-term"]),
    ]);
    await proxy.listTools();
    const server = Number(readFileSync(join(pids, "server"), "utf8"));
    await waitFor(() => existsSync(join(pids, "child")));
    const child = Number(readFileSync(join(pids, "child"), "utf8"));
    expect(alive(child)).toBe(true);
    await proxy.close();
    await waitFor(() => !alive(server) && !alive(child), 5000);
  });

  it("a call that never answers times out, and the server is told to cancel", async () => {
    const calls = join(tempDir("chalito-calls-"), "calls.log");
    const { dir, proxy, audits } = rig({ callTimeoutMs: 200 });
    install(dir, [stdio("fx", {}, ["--calls", calls])]);
    const r = await proxy.callTool("fx__sleep", {}, client, signal());
    expect(textOf(r)).toContain("connector_timeout");
    await waitFor(() => readFileSync(calls, "utf8").includes("cancelled"));
    expect(audits.find((a) => a.type === "connector.call")!.meta).toMatchObject({
      ok: false,
      error: "connector_timeout",
    });
  });

  it("a server's error text is scrubbed of its token and stays out of the audit", async () => {
    const secrets = new MemorySecretStore();
    const token = "tok_ERRORPATH_5521";
    await secrets.set(secretName("fx", "FIXTURE_TOKEN"), token);
    const { dir, proxy, audits } = rig({ secrets });
    install(dir, [stdio("fx", { auth: "token", secretEnv: ["FIXTURE_TOKEN"] })]);
    const r = await proxy.callTool("fx__fail_secret", {}, client, signal());
    expect(textOf(r)).toContain("bad token [secret]");
    expect(textOf(r)).not.toContain(token);
    await proxy.callTool("fx__fail", {}, client, signal());
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain("ignore all rules");
  });

  it("an edit or uninstall between list and call wins: the old tool name no longer runs", async () => {
    const calls = join(tempDir("chalito-calls-"), "calls.log");
    const { dir, proxy } = rig();
    install(dir, [stdio("fx", {}, ["--calls", calls])]);
    await proxy.listTools();
    install(dir, [stdio("fx", { source: "community", confirmedWarning: false }, ["--calls", calls])]);
    const r = await proxy.callTool("fx__echo", { text: "x" }, client, signal());
    expect(r.isError).toBe(true);
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
    expect(proxy.running()).toEqual([]);
  });

  it("two ids with the same slug get distinct names and reach their own server", async () => {
    const { dir, proxy } = rig();
    install(dir, [stdio("a.b"), stdio("a-b")]);
    const names = (await proxy.listTools()).map((t) => t.name).filter((n) => n.endsWith("__echo"));
    expect(names.sort()).toEqual(["a-b-2__echo", "a-b__echo"]);
    expect(textOf(await proxy.callTool("a-b-2__echo", { text: "two" }, client, signal()))).toContain('source="a-b-2"');
  });
});

describe("connections proxy: remote failure modes", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  const remote = (id: string, url: string): InstalledConnector => ({
    id,
    name: id,
    description: "",
    source: "verified",
    transport: "remote",
    server: { url },
    auth: "token",
    installedAt: 1,
    confirmedWarning: false,
  });
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });

  it("never follows a redirect with the token, and a 401 is reported as unauthorized", async () => {
    let leaked = 0;
    const target = await listen((req, res) => {
      leaked++;
      res.writeHead(200).end();
    });
    const redirector = await listen((_req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${target}/mcp` }).end(),
    );
    const denier = await listen((_req, res) => res.writeHead(401).end());
    const secrets = new MemorySecretStore();
    await secrets.set(secretName("redir", "token"), "tok-redirect");
    await secrets.set(secretName("denied", "token"), "tok-denied");
    const { dir, proxy, audits } = rig({ secrets });
    install(dir, [
      remote("redir", `http://127.0.0.1:${redirector}/mcp`),
      remote("denied", `http://127.0.0.1:${denier}/mcp`),
    ]);
    expect(await proxy.listTools()).toEqual([]);
    expect(leaked).toBe(0);
    expect(audits).toContainEqual({
      type: "connector.unavailable",
      meta: { connector: "redir", error: "connector_unavailable" },
    });
    expect(audits).toContainEqual({
      type: "connector.unavailable",
      meta: { connector: "denied", error: "connector_unauthorized" },
    });
  });

  it("re-initializes after the server forgets its MCP session", async () => {
    let session = 0;
    let live = "";
    const port = await listen(async (req, res) => {
      if (req.method === "DELETE") return res.writeHead(200).end();
      const msg = await readBody(req);
      if (msg.method === "initialize") {
        live = `s${++session}`;
        return res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": live })
          .end(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
          );
      }
      if (req.headers["mcp-session-id"] !== live) return res.writeHead(404).end();
      if (msg.id === undefined) return res.writeHead(202).end();
      const result =
        msg.method === "tools/list"
          ? { tools: [{ name: "ping_me", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `pong ${live}` }] };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
    const secrets = new MemorySecretStore();
    await secrets.set(secretName("r", "token"), "tok-r");
    const { dir, proxy } = rig({ secrets });
    install(dir, [remote("r", `http://127.0.0.1:${port}/mcp`)]);
    expect(textOf(await proxy.callTool("r__ping_me", {}, client, signal()))).toContain("pong s1");
    live = "gone";
    expect(textOf(await proxy.callTool("r__ping_me", {}, client, signal()))).toContain("connector_session_expired");
    expect(textOf(await proxy.callTool("r__ping_me", {}, client, signal()))).toContain("pong s2");
  });
});

describe("connections proxy: revoke and approval races", () => {
  it("an uninstall or edit while the phone approval is pending refuses the call", async () => {
    const calls = join(tempDir("chalito-calls-"), "calls.log");
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const { dir, proxy, audits } = rig({ gate: async () => (await waiting, { allow: true, reason: "approved" }) });
    install(dir, [stdio("fx", {}, ["--calls", calls])]);
    await proxy.listTools();
    const pending = proxy.callTool("fx__show_env", { name: "PATH" }, client, signal());
    await new Promise((r) => setTimeout(r, 20));
    install(dir, [stdio("fx", {}, ["--calls", calls, "--changed"])]);
    release();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("changed or removed");
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
    expect(audits.find((a) => a.type === "connector.call")!.meta).toMatchObject({
      decision: "deny",
      reason: "changed",
    });
  });

  it("revoke-all while an approval is pending: the call never reaches a server and nothing is left running", async () => {
    const pids = tempDir("chalito-pid-");
    const calls = join(pids, "calls.log");
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const { dir, proxy } = rig({ gate: async () => (await waiting, { allow: true, reason: "approved" }) });
    install(dir, [stdio("fx", {}, ["--calls", calls, "--pidfile", join(pids, "fx")])]);
    await proxy.listTools();
    const pid = Number(readFileSync(join(pids, "fx"), "utf8"));
    const pending = proxy.callTool("fx__show_env", { name: "PATH" }, client, signal());
    const revoking = proxy.revokeAll("test");
    // A list during revoke-all starts nothing.
    expect(await proxy.listTools()).toEqual([]);
    await revoking;
    release();
    expect((await pending).isError).toBe(true);
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
    expect(proxy.running()).toEqual([]);
    await waitFor(() => !alive(pid), 5000);
  });

  it("a keychain that won't delete makes revoke-all report itself incomplete", async () => {
    const secrets = new MemorySecretStore();
    secrets.delete = async () => {
      throw new Error("locked");
    };
    const { dir, proxy, audits } = rig({ secrets });
    install(dir, [stdio("fx")]);
    await expect(proxy.revokeAll("test")).rejects.toThrow("revoke_incomplete");
    expect(audits.find((a) => a.type === "connector.revoke_all")!.meta).toMatchObject({ secretsFailed: 1 });
    expect(readInstalled(dir)).toEqual([]);
  });

  it("when the server leader dies by itself, its grandchild (the real server) dies too", async () => {
    const pids = tempDir("chalito-pid-");
    const { dir, proxy } = rig({ restartMs: 60_000 });
    install(dir, [stdio("fx", {}, ["--pidfile", join(pids, "server"), "--spawn-child", join(pids, "child")])]);
    await proxy.listTools();
    await waitFor(() => existsSync(join(pids, "child")));
    const child = Number(readFileSync(join(pids, "child"), "utf8"));
    await proxy.callTool("fx__crash", {}, client, signal());
    await waitFor(() => !alive(child), 5000);
  });

  it("a result that isn't an MCP result is an error, not an empty success", async () => {
    const { dir, proxy } = rig();
    install(dir, [stdio("fx")]);
    const r = await proxy.callTool("fx__garbage", {}, client, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("connector_protocol");
  });
});
