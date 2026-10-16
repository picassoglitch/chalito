import { afterEach, describe, expect, it } from "vitest";
import { AgentCard } from "@a2a-js/sdk";
import { A2aAdapter, a2aRecipeProblem, authHeader, usableInterfaces } from "../src/a2a/index.js";
import type { AdapterEvent } from "../src/core.js";
import { AGENT_KEY, AGENT_ORIGIN, startTestAgent } from "./a2a-fixture.js";
import { waitFor } from "./conformance.js";

/**
 * The `a2a` driver against a test agent built from the official @a2a-js/sdk 1.3.0 server
 * (DefaultRequestHandler + the SDK's express JSON-RPC and HTTP+JSON handlers): both v1.0 bindings,
 * streaming and not, input-required continuation, cancel, failure, auth and the origin pin.
 */
const recipe = (binding?: "JSONRPC" | "HTTP+JSON") => ({
  id: "test-agent",
  name: "Test agent",
  driver: { a2a: { url: AGENT_ORIGIN, ...(binding ? { binding } : {}) } },
});

let agent: Awaited<ReturnType<typeof startTestAgent>> | null = null;
afterEach(async () => {
  await agent?.close();
  agent = null;
});

const run = async (
  a: A2aAdapter,
  prompt: string,
  gate: () => Promise<{ allow: true }> = async () => ({ allow: true }),
) => {
  const events: AdapterEvent[] = [];
  const gated: string[] = [];
  const handle = await a.start({
    sid: "s1",
    cwd: "/ws",
    prompt,
    origin: "client:phone1",
    permissionMode: "default",
    gate: async (c) => {
      gated.push(c.toolName);
      return gate();
    },
    askUser: async () => ({}),
    onEvent: (e) => events.push(e),
  });
  const idles = () => events.filter((e) => e.type === "state" && e.state === "idle").length;
  return { events, gated, handle, idles };
};
const texts = (events: AdapterEvent[]) => events.flatMap((e) => (e.type === "assistant_text" ? [e.text] : []));

for (const binding of ["JSONRPC", "HTTP+JSON"] as const) {
  describe(`a2a driver over ${binding} (SDK test agent)`, () => {
    it("runs a prompt as a task: streamed artifact chunks become the reply; the context is the session", async () => {
      agent = await startTestAgent();
      const a = new A2aAdapter(recipe(binding), { apiKey: AGENT_KEY, fetch: agent.fetch });
      const r = await run(a, "hola");
      await waitFor(() => r.idles() === 1);
      expect(texts(r.events)).toEqual(["eco: hola"]);
      const started = r.events.find((e) => e.type === "started");
      expect(started).toMatchObject({ type: "started" });
      expect(agent.seen[0]!.contextId).toBe((started as { providerSessionId: string }).providerSessionId);
      // The key went in the header the card names, and only to the agent's own origin.
      expect(agent.auths.at(-1)).toBe(AGENT_KEY);
      expect(agent.calls.every((u) => u.startsWith(AGENT_ORIGIN))).toBe(true);
      expect(
        agent.calls.some((u) => u.includes(binding === "JSONRPC" ? "/a2a/jsonrpc" : "/a2a/rest/message:stream")),
      ).toBe(true);
      // A remote agent gets no local tool: the gate is never asked.
      expect(r.gated).toEqual([]);
      r.handle.close();
      await r.handle.done;
      expect(r.events.at(-1)).toEqual({ type: "state", state: "completed" });
    });

    it("input-required: the session goes idle with the question, and the next prompt continues that task", async () => {
      agent = await startTestAgent();
      const r = await run(new A2aAdapter(recipe(binding), { apiKey: AGENT_KEY, fetch: agent.fetch }), "pregunta");
      await waitFor(() => r.idles() === 1);
      expect(texts(r.events)).toEqual(["¿Cuál base de datos?"]);
      r.handle.prompt("Postgres", "client:phone1");
      await waitFor(() => r.idles() === 2);
      expect(agent.seen[1]).toMatchObject({ text: "Postgres", taskId: agent.seen[0]!.taskId, continued: true });
      expect(texts(r.events).at(-1)).toBe("eco: Postgres (continúa)");
      // A completed task isn't continued: the third prompt is a new task in the same context.
      r.handle.prompt("otra", "client:phone1");
      await waitFor(() => r.idles() === 3);
      expect(agent.seen[2]!.taskId).not.toBe(agent.seen[0]!.taskId);
      expect(agent.seen[2]!.contextId).toBe(agent.seen[0]!.contextId);
      r.handle.close();
      await r.handle.done;
    });

    it("interrupt cancels the remote task (CancelTask) and the state says interrupted", async () => {
      agent = await startTestAgent();
      const r = await run(new A2aAdapter(recipe(binding), { apiKey: AGENT_KEY, fetch: agent.fetch }), "lento");
      await waitFor(() => agent!.seen.length === 1);
      // Wait until the task id came back to the client.
      await new Promise((res) => setTimeout(res, 50));
      await r.handle.interrupt();
      await waitFor(() => agent!.cancels.length === 1);
      expect(agent.cancels).toEqual([agent.seen[0]!.taskId]);
      expect(r.events).toContainEqual({ type: "state", state: "interrupted" });
      r.handle.close();
      await r.handle.done;
    });

    it("a failed task is an error, and the session stays usable", async () => {
      agent = await startTestAgent();
      const r = await run(new A2aAdapter(recipe(binding), { apiKey: AGENT_KEY, fetch: agent.fetch }), "falla");
      await waitFor(() => r.idles() === 1);
      expect(r.events).toContainEqual({ type: "error", code: "internal", message: "Test agent failed the task" });
      r.handle.prompt("hola", "client:phone1");
      await waitFor(() => r.idles() === 2);
      expect(texts(r.events)).toContain("eco: hola");
      r.handle.close();
      await r.handle.done;
    });
  });
}

describe("a2a driver: the card, auth and the origin pin", () => {
  it("a wrong key fails the turn as auth_required", async () => {
    agent = await startTestAgent();
    const r = await run(new A2aAdapter(recipe(), { apiKey: "wrong", fetch: agent.fetch }), "hola");
    await waitFor(() => r.events.some((e) => e.type === "state" && e.state === "failed"));
    expect(r.events.find((e) => e.type === "error")).toMatchObject({ code: "auth_required" });
    r.handle.close();
    await r.handle.done;
  });

  it("without streaming in the card, SendMessage (non-streaming) is used", async () => {
    agent = await startTestAgent({ streaming: false });
    const r = await run(new A2aAdapter(recipe(), { apiKey: AGENT_KEY, fetch: agent.fetch }), "hola");
    await waitFor(() => r.idles() === 1);
    expect(texts(r.events)).toEqual(["eco: hola"]);
    r.handle.close();
    await r.handle.done;
  });

  it("refuses a card whose interfaces are on another origin (the key never leaves the recipe's origin)", async () => {
    agent = await startTestAgent({ interfaceOrigin: "https://elsewhere.test" });
    const a = new A2aAdapter(recipe(), { apiKey: AGENT_KEY, fetch: agent.fetch });
    await expect(run(a, "hola")).rejects.toThrow(/offers no A2A 1.0/);
    expect(agent.calls.some((u) => u.startsWith("https://elsewhere.test"))).toBe(false);
  });

  it("usableInterfaces keeps v1.0 JSON-RPC / HTTP+JSON on the origin, preferred binding first", () => {
    const card = AgentCard.fromJSON({
      name: "x",
      description: "x",
      version: "1",
      capabilities: {},
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      supportedInterfaces: [
        { url: "https://a.test/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://a.test/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
        { url: "https://a.test/old", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
        { url: "https://a.test/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
        { url: "http://a.test/plain", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://b.test/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
    });
    expect(usableInterfaces(card, "https://a.test", "HTTP+JSON").map((i) => i.url)).toEqual([
      "https://a.test/rest",
      "https://a.test/rpc",
    ]);
    expect(authHeader(card, "k")).toEqual({ authorization: "Bearer k" });
  });

  it("recipes: https only, no credentials or query in the URL", () => {
    expect(a2aRecipeProblem(recipe())).toBeNull();
    expect(a2aRecipeProblem({ ...recipe(), driver: { a2a: { url: "http://agent.test" } } })).toMatch(/https/);
    expect(a2aRecipeProblem({ ...recipe(), driver: { a2a: { url: "https://u:p@agent.test" } } })).toMatch(
      /credentials/,
    );
    expect(a2aRecipeProblem({ ...recipe(), driver: {} })).toMatch(/no a2a driver/);
  });
});
