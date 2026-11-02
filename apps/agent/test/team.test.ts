import { duplexPair, PassThrough, type Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { runTeamMcp } from "../src/team/mcp.js";
import { startCodeServer } from "../src/code/server.js";
import type { CodeService } from "../src/code/service.js";

const workspaceFor = (cwd: string) => (cwd === "/project" ? "project" : cwd === "/other" ? "other" : null);
const join = (hub: TeamHub, signal: AbortSignal, provider = "claude", cwd = "/project") =>
  hub.call(signal, "team_join", { provider, cwd }) as {
    ok: boolean;
    result: { self: string; peers: unknown[]; messages: unknown[] };
  };

describe("automatic workspace team", () => {
  it("isolates workspaces and connection identities; retains a departing peer's result for remaining peers", () => {
    const hub = new TeamHub(workspaceFor, Date.now, () => true);
    const a = new AbortController(),
      b = new AbortController(),
      outside = new AbortController();
    const claude = join(hub, a.signal);
    join(hub, b.signal, "codex");
    join(hub, outside.signal, "grok", "/other");
    expect(hub.call(b.signal, "team_send", { to: claude.result.self, kind: "result", text: "Tests passed" }).ok).toBe(
      true,
    );
    b.abort();
    expect(hub.call(a.signal, "team_read", {})).toMatchObject({
      result: { messages: [{ provider: "codex", text: "Tests passed" }], peers: [] },
    });
    expect(hub.call(a.signal, "team_read", {})).toMatchObject({ result: { messages: [] } });
    expect(hub.call(outside.signal, "team_read", {})).toMatchObject({ result: { messages: [], peers: [] } });
    expect(hub.call(outside.signal, "team_send", { to: claude.result.self, text: "leak" })).toMatchObject({
      ok: false,
    });
    expect(join(hub, a.signal, "grok", "/other")).toMatchObject({ ok: false, error: "already_joined" });
    expect(join(hub, new AbortController().signal, "claude", "/unknown")).toMatchObject({ ok: false });
    expect(hub.call(a.signal, "team_send", { text: "x", provider: "grok" })).toMatchObject({ ok: false });
    a.abort();
    outside.abort();
  });

  it("bounds spam, rejects invalid messages, and expires retained data", () => {
    let now = 0;
    const hub = new TeamHub(
      workspaceFor,
      () => now,
      () => true,
    );
    const a = new AbortController(),
      b = new AbortController();
    join(hub, a.signal);
    join(hub, b.signal, "cursor");
    expect(hub.call(a.signal, "team_send", { text: "x".repeat(8001) }).ok).toBe(false);
    expect(hub.call(a.signal, "team_send", { text: "   " }).ok).toBe(false);
    expect(hub.call(a.signal, "team_read", { workspace: "/other" }).ok).toBe(false);
    for (let n = 0; n < 30; n++) expect(hub.call(a.signal, "team_send", { text: String(n) }).ok).toBe(true);
    expect(hub.call(a.signal, "team_send", { text: "too many" })).toMatchObject({ error: "rate_limited" });
    now = 3_600_001;
    expect(hub.call(b.signal, "team_read", {})).toMatchObject({ result: { messages: [] } });
    expect(hub.call(a.signal, "team_send", { text: "new" }).ok).toBe(true);
    a.abort();
    b.abort();
    expect(hub.call(a.signal, "team_read", {}).ok).toBe(false);
    expect(hub.call(new AbortController().signal, "team_read", {})).toMatchObject({ error: "join_first" });
  });

  it("reports dropped history and revokes membership when workspace policy changes", () => {
    let allowed = true,
      now = 0;
    const hub = new TeamHub(
      (cwd) => (allowed ? workspaceFor(cwd) : null),
      () => now,
      () => true,
    );
    const a = new AbortController(),
      b = new AbortController();
    join(hub, a.signal);
    join(hub, b.signal, "grok");
    for (let n = 0; n < 65; n++) {
      now += 60_001;
      expect(hub.call(a.signal, "team_send", { text: String(n) }).ok).toBe(true);
    }
    expect(hub.call(b.signal, "team_read", {})).toMatchObject({ result: { historyTruncated: true } });
    allowed = false;
    expect(hub.call(a.signal, "team_send", { text: "revoked" })).toMatchObject({ error: "join_first" });
    allowed = true;
    expect(join(hub, b.signal, "grok").result.messages).toEqual([]);
    a.abort();
    b.abort();
  });

  it("connects four provider-labelled MCP clients through the local server and exchanges requests and results", async () => {
    let accept!: (stream: Duplex) => void;
    const server = await startCodeServer({
      path: "team-test",
      team: new TeamHub(workspaceFor, Date.now, () => true),
      platform: "win32",
      code: { workspaceFor, tap: () => () => undefined } as unknown as CodeService,
      listen: (_path, onStream) => {
        accept = onStream;
        return { close() {} };
      },
    });
    const clients = ["claude", "codex", "grok", "cursor"].map((provider) => {
      const [client, socket] = duplexPair();
      accept(socket);
      const input = new PassThrough();
      const replies = new Map<
        number,
        { result: { instructions: string; isError?: boolean; content: { text: string }[] } }
      >();
      let errors = "";
      const done = runTeamMcp(
        {
          input,
          out: (line) => {
            const r = JSON.parse(line);
            replies.set(r.id, r);
          },
          err: (text) => {
            errors += text;
          },
          openPipe: () => ({ ok: true, stream: client }),
        },
        "team-test",
        provider,
        "/project",
      );
      let id = 0;
      return {
        input,
        client,
        socket,
        done,
        errors: () => errors,
        call: async (method: string, params: unknown = {}) => {
          const current = ++id;
          input.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
          await vi.waitFor(() => expect(replies.has(current)).toBe(true));
          return replies.get(current)!;
        },
      };
    });
    const tool = async (index: number, name: string, args = {}) => {
      const reply = await clients[index]!.call("tools/call", { name, arguments: args });
      expect(reply.result.isError).not.toBe(true);
      return JSON.parse(reply.result.content[0]!.text).peerData;
    };
    try {
      for (const c of clients) {
        expect((await c.call("initialize", { protocolVersion: "2025-11-25" })).result.instructions).toContain(
          "Coordinate automatically",
        );
      }
      const peers = await tool(0, "team_read");
      expect(peers.peers.map((p: { provider: string }) => p.provider).sort()).toEqual(["codex", "cursor", "grok"]);
      const grok = peers.peers.find((p: { provider: string }) => p.provider === "grok");
      await tool(0, "team_send", { to: grok.id, kind: "request", text: "Review the approach" });
      expect((await tool(1, "team_read")).messages).toEqual([]);
      expect((await tool(2, "team_read")).messages).toMatchObject([{ provider: "claude", kind: "request" }]);
      await tool(2, "team_send", { to: peers.self, kind: "result", text: "Review complete" });
      expect((await tool(0, "team_read")).messages).toMatchObject([{ provider: "grok", text: "Review complete" }]);
      await tool(3, "team_send", { text: "Working on UI" });
      expect((await tool(0, "team_read")).messages).toMatchObject([{ provider: "cursor", text: "Working on UI" }]);
      clients[3]!.input.end();
      expect(await clients[3]!.done).toBe(0);
      await vi.waitFor(async () => expect((await tool(0, "team_read")).peers).toHaveLength(2));
    } finally {
      for (const c of clients) c.input.end();
      expect(await Promise.all(clients.map((c) => c.done))).toEqual([0, 0, 0, 0]);
      for (const c of clients) {
        c.client.destroy();
        c.socket.destroy();
        expect(c.errors()).toBe("");
      }
      await server.close();
    }
  });
});
