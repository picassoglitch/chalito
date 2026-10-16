import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_CARD_PATH, AgentCard, Role, TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import express from "express";

/**
 * A test A2A v1.0 agent built from the official SDK's own server (DefaultRequestHandler,
 * InMemoryTaskStore, the express JSON-RPC and HTTP+JSON handlers and the Agent Card handler), on a
 * real loopback HTTP server. Tests reach it as `https://agent.test` through `fetch` below, which
 * rewrites the origin: the adapter only ever talks https.
 *
 * Its executor answers by prompt:
 * - "pregunta": asks for input (TASK_STATE_INPUT_REQUIRED); the next message continues that task.
 * - "lento": works until canceled.
 * - "falla": fails the task.
 * - anything else: streams "eco: <prompt>" as a two-chunk artifact, then completes.
 */
export const AGENT_ORIGIN = "https://agent.test";
export const AGENT_KEY = "a2a_test_key_123";

const text = (value: string): Part => ({
  content: { $case: "text", value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});
const agentMessage = (contextId: string, taskId: string, value: string): Message => ({
  messageId: `m_${Math.random().toString(36).slice(2)}`,
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [text(value)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

export interface Seen {
  text: string;
  taskId: string;
  contextId: string;
  continued: boolean;
  auth: string | undefined;
}

export const startTestAgent = async (opts: { streaming?: boolean; interfaceOrigin?: string } = {}) => {
  const seen: Seen[] = [];
  const cancels: string[] = [];
  const slow = new Map<string, () => void>();
  const auths: (string | undefined)[] = [];
  const iface = opts.interfaceOrigin ?? AGENT_ORIGIN;

  const card = AgentCard.fromJSON({
    name: "Test agent",
    description: "Echoes, asks, fails or waits, for the A2A conformance tests.",
    supportedInterfaces: [
      { url: `${iface}/a2a/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${iface}/a2a/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    version: "1",
    capabilities: { streaming: opts.streaming ?? true },
    securitySchemes: { key: { apiKeySecurityScheme: { location: "header", name: "X-Agent-Key" } } },
    securityRequirements: [{ schemes: { key: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "echo", name: "Echo", description: "Echoes the prompt.", tags: ["test"] }],
  });

  const status = (contextId: string, taskId: string, state: TaskState, message?: string) =>
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state,
        message: message ? agentMessage(contextId, taskId, message) : undefined,
        timestamp: new Date().toISOString(),
      },
      metadata: undefined,
    });

  const executor: AgentExecutor = {
    execute: async (ctx, bus: ExecutionEventBus) => {
      const prompt = ctx.userMessage.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
      seen.push({
        text: prompt,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        continued: !!ctx.task,
        auth: auths.at(-1),
      });
      const task: Task = ctx.task ?? {
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [ctx.userMessage],
        metadata: undefined,
      };
      bus.publish(AgentEvent.task(task));
      bus.publish(status(ctx.contextId, ctx.taskId, TaskState.TASK_STATE_WORKING));
      if (prompt === "pregunta") {
        bus.publish(status(ctx.contextId, ctx.taskId, TaskState.TASK_STATE_INPUT_REQUIRED, "¿Cuál base de datos?"));
      } else if (prompt === "lento") {
        await new Promise<void>((resolve) => slow.set(ctx.taskId, resolve));
        return;
      } else if (prompt === "falla") {
        bus.publish(status(ctx.contextId, ctx.taskId, TaskState.TASK_STATE_FAILED, "No pude."));
      } else {
        const artifactId = `a_${ctx.taskId}`;
        const reply = `eco: ${prompt}${ctx.task ? " (continúa)" : ""}`;
        const half = Math.ceil(reply.length / 2);
        for (const [i, chunk] of [reply.slice(0, half), reply.slice(half)].entries())
          bus.publish(
            AgentEvent.artifactUpdate({
              taskId: ctx.taskId,
              contextId: ctx.contextId,
              artifact: {
                artifactId,
                name: "reply",
                description: "",
                parts: [text(chunk)],
                metadata: undefined,
                extensions: [],
              },
              append: i > 0,
              lastChunk: i > 0,
              metadata: undefined,
            }),
          );
        bus.publish(status(ctx.contextId, ctx.taskId, TaskState.TASK_STATE_COMPLETED));
      }
      bus.finished();
    },
    cancelTask: async (taskId, bus) => {
      cancels.push(taskId);
      const s = seen.find((x) => x.taskId === taskId);
      bus.publish(status(s?.contextId ?? "", taskId, TaskState.TASK_STATE_CANCELED));
      bus.finished();
      slow.get(taskId)?.();
    },
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  // The card is public, in ProtoJSON as the spec serves it (§8.2). The SDK's express
  // agentCardHandler (1.3.0) writes the codec's internal form instead, so it isn't used.
  app.get(`/${AGENT_CARD_PATH}`, (_req, res) => {
    res.json(AgentCard.toJSON(card));
  });
  // Every A2A call needs the key the card names.
  app.use("/a2a", (req, res, next) => {
    auths.push(req.header("x-agent-key"));
    if (req.header("x-agent-key") !== AGENT_KEY) {
      res.status(401).json({ error: { code: 401, status: "UNAUTHENTICATED", message: "bad key", details: [] } });
      return;
    }
    next();
  });
  app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const calls: string[] = [];
  /** https://agent.test → the loopback server; any other origin is refused (and recorded). */
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (!url.startsWith(AGENT_ORIGIN)) return Promise.reject(new Error(`test agent: no route to ${url}`));
    return fetch(base + url.slice(AGENT_ORIGIN.length), init);
  }) as typeof fetch;

  return {
    card,
    seen,
    cancels,
    auths,
    calls,
    fetch: fetchImpl,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};
