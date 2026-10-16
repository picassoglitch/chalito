import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { A2A_PROTOCOL_VERSION, AgentCard as SdkAgentCard, Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type TaskStore,
  type User,
} from "@a2a-js/sdk/server";
import { fromB64url, sealJson } from "@chalito/crypto";
import { AgentCard } from "@chalito/protocol";
import { GatewayApiError, type GatewayApi } from "./api-client.js";
import { readLinkTask, type LinkTaskState } from "./link-task.js";
import type { GatewayReader, GatewayToken } from "./reader.js";

/**
 * Chalito as an A2A v1.0 server (ADR 0022 §4), a module of the MCP gateway: same read-only
 * database role, same token lookup on every call, writes only through the api.
 *
 * - **Off by default.** Mounted only when `CHALITO_A2A_ENABLED=1` and `CHALITO_A2A_RESOURCE` are
 *   set; otherwise every path is a 404. No domain is configured here (owner decision #36).
 * - **Only what the owner exposes.** Each exposed agent is `/a2a/<exposureId>` (an opaque,
 *   unguessable id), with its Agent Card at `/a2a/<exposureId>/.well-known/agent-card.json`. An
 *   id that isn't exposed (or was revoked) is a 404, card included.
 * - **OAuth through the M10 authorization server.** A caller presents an access token issued for
 *   this resource (RFC 8707) with `link:handoff`, granted by the same owner on their phone with
 *   their passkey. Its origin is `a2a:<grantId>`: relayed, never signed, never auto-approved.
 * - **Every task goes through the LinkAuthorizer** (in the api, deny-all by default) and only then
 *   becomes a RelayedCommand. A refused task comes back `TASK_STATE_REJECTED`; an accepted one
 *   `TASK_STATE_SUBMITTED`. Over a link set to "ask me each time" it is `TASK_STATE_AUTH_REQUIRED`
 *   until the owner's signed tap on their phone; GetTask then shows `WORKING` (delivered) or
 *   `REJECTED` (declined, or no answer in time) (link-task.ts, M16 F).
 * - **Binding:** JSON-RPC 2.0 only (the SDK's JsonRpcTransportHandler on the SDK's
 *   DefaultRequestHandler). The card offers no other interface, no push notifications, no
 *   extended card.
 */
export interface A2aConfig {
  /** This server's resource URL (the tokens' audience), e.g. https://<gateway>/a2a. */
  resource: string;
  /** The authorization server (the api's issuer). */
  issuer: string;
}

export interface A2aDeps {
  reader: GatewayReader;
  api: GatewayApi;
  cfg: A2aConfig;
  now: () => number;
}

const MAX_PROMPT = 8000;
const EXPOSURE_ID = /^a2x_[A-Za-z0-9_-]{16,64}$/;
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** The full card of one exposure: the owner's card body plus this server's interface and OAuth. */
export const exposureCard = (cfg: A2aConfig, exposureId: string, body: Record<string, unknown>): AgentCard =>
  AgentCard.parse({
    ...body,
    supportedInterfaces: [
      { url: `${cfg.resource}/${exposureId}`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      chalito: {
        oauth2SecurityScheme: {
          description: "Chalito's OAuth 2.1 server (PKCE S256, RFC 8707 resource = this server).",
          flows: {
            authorizationCode: {
              authorizationUrl: `${cfg.issuer}/oauth/authorize`,
              tokenUrl: `${cfg.issuer}/oauth/token`,
              scopes: { "link:handoff": "Hand tasks to this agent, over a link its owner made." },
              pkceRequired: true,
            },
          },
          oauth2MetadataUrl: `${cfg.issuer}/.well-known/oauth-authorization-server`,
        },
      },
    },
    securityRequirements: [{ schemes: { chalito: { list: ["link:handoff"] } } }],
  });

class GrantUser implements User {
  constructor(private readonly scope: string) {}
  get isAuthenticated() {
    return true;
  }
  get userName() {
    return this.scope;
  }
}

const agentText = (contextId: string, taskId: string, text: string): Message => ({
  messageId: randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

export const createA2aServer = (deps: A2aDeps) => {
  const base = new URL(deps.cfg.resource);
  const path = base.pathname.replace(/\/+$/, "");
  const prmPath = `/.well-known/oauth-protected-resource${path}`;
  // Tasks live in this instance only, scoped per grant (the SDK keys them by the call's user).
  // A task still waiting on the owner (or the device) is refreshed from the database on each read.
  const inner = new InMemoryTaskStore();
  const waiting = new Map<
    string,
    { owner: string; deviceId: string; cid: string; confirm: boolean; issuedAt: number }
  >();
  const STATE: Record<LinkTaskState, TaskState> = {
    TASK_STATE_SUBMITTED: TaskState.TASK_STATE_SUBMITTED,
    TASK_STATE_AUTH_REQUIRED: TaskState.TASK_STATE_AUTH_REQUIRED,
    TASK_STATE_WORKING: TaskState.TASK_STATE_WORKING,
    TASK_STATE_REJECTED: TaskState.TASK_STATE_REJECTED,
    TASK_STATE_FAILED: TaskState.TASK_STATE_FAILED,
  };
  const tasks: TaskStore = {
    save: (task, ctx) => inner.save(task, ctx),
    list: (params, ctx) => inner.list(params, ctx),
    load: async (taskId, ctx) => {
      const task = await inner.load(taskId, ctx);
      const w = task && waiting.get(taskId);
      if (!task || !w) return task;
      const now = deps.now();
      const r = await readLinkTask(deps.reader, w.owner, w, now);
      const state = STATE[r.state];
      // Once delivered or refused, nothing here changes it again (progress isn't relayed yet).
      if (state !== TaskState.TASK_STATE_AUTH_REQUIRED && state !== TaskState.TASK_STATE_SUBMITTED)
        waiting.delete(taskId);
      if (state === task.status?.state) return task;
      const next: Task = {
        ...task,
        status: {
          state,
          message: agentText(task.contextId, task.id, r.note),
          timestamp: new Date(now).toISOString(),
        },
      };
      await inner.save(next, ctx);
      return next;
    },
  };

  const unauthorized = (c: Context, error = "invalid_token") =>
    c.json({ error }, 401, {
      "www-authenticate": `Bearer resource_metadata="${base.origin}${prmPath}", scope="link:handoff"`,
    });

  /** The bearer token: live, for THIS resource, with link:handoff. Looked up on every call. */
  const tokenOf = async (c: Context): Promise<(GatewayToken & { raw: string }) | Response> => {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(c.req.header("authorization") ?? "");
    if (!m) return unauthorized(c);
    const t = await deps.reader.accessToken(sha256hex(m[1]!), deps.now());
    if (!t || t.resource.replace(/\/+$/, "") !== deps.cfg.resource.replace(/\/+$/, "")) return unauthorized(c);
    if (!t.scopes.includes("link:handoff")) return c.json({ error: "insufficient_scope" }, 403);
    return { ...t, raw: m[1]! };
  };

  const executorFor = (tok: GatewayToken & { raw: string }, exposureId: string, deviceId: string): AgentExecutor => ({
    execute: async (ctx, bus) => {
      const text = ctx.userMessage.parts
        .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
        .join("")
        .slice(0, MAX_PROMPT);
      const finish = (state: TaskState, note: string) => {
        const task: Task = {
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state,
            message: agentText(ctx.contextId, ctx.taskId, note),
            timestamp: new Date(deps.now()).toISOString(),
          },
          artifacts: [],
          history: [ctx.userMessage],
          metadata: undefined,
        };
        bus.publish(AgentEvent.task(task));
        bus.finished();
      };
      if (!text.trim()) return finish(TaskState.TASK_STATE_REJECTED, "Only text tasks are accepted.");
      const pubBox = await deps.reader.agentBoxKey(tok.owner, deviceId);
      if (!pubBox) return finish(TaskState.TASK_STATE_REJECTED, "The agent's computer isn't available.");
      const cid = `lnk_${randomUUID().replace(/-/g, "")}`;
      const promptCt = await sealJson(text, { [deviceId]: await fromB64url(pubBox) }, `command:${cid}`);
      try {
        const issuedAt = deps.now();
        const r = await deps.api.linkTask(tok.raw, { cid, promptCt, exposureId });
        const confirm = r?.state === "TASK_STATE_AUTH_REQUIRED";
        // The device names the task's session after its command id: GetTask follows it there.
        waiting.set(ctx.taskId, { owner: tok.owner, deviceId, cid, confirm, issuedAt });
        if (confirm) finish(TaskState.TASK_STATE_AUTH_REQUIRED, "Waiting for the owner to confirm on their phone.");
        else finish(TaskState.TASK_STATE_SUBMITTED, "Handed to the owner's agent.");
      } catch (err) {
        if (!(err instanceof GatewayApiError)) throw err;
        finish(TaskState.TASK_STATE_REJECTED, `Chalito refused the task (${err.reason ?? err.code}).`);
      }
    },
    // Nothing runs here: an accepted task is the device's from then on.
    cancelTask: async (taskId, bus) => {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: "",
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            message: undefined,
            timestamp: new Date(deps.now()).toISOString(),
          },
          metadata: undefined,
        }),
      );
      bus.finished();
    },
  });

  const app = new Hono();
  app.get(prmPath, (c) =>
    c.json({
      resource: deps.cfg.resource,
      authorization_servers: [deps.cfg.issuer],
      scopes_supported: ["link:handoff"],
      bearer_methods_supported: ["header"],
      resource_name: "Chalito A2A",
    }),
  );

  app.get(`${path}/:id/.well-known/agent-card.json`, async (c) => {
    const id = c.req.param("id");
    const e = EXPOSURE_ID.test(id) ? await deps.reader.exposure(id) : null;
    if (!e) return c.json({ error: "not_found" }, 404);
    // ProtoJSON (A2A 1.0 §8.2), through the SDK's codec.
    return c.json(SdkAgentCard.toJSON(SdkAgentCard.fromJSON(exposureCard(deps.cfg, id, e.card))));
  });

  app.post(`${path}/:id`, async (c) => {
    const id = c.req.param("id");
    const tok = await tokenOf(c);
    if (tok instanceof Response) return tok;
    const e = EXPOSURE_ID.test(id) ? await deps.reader.exposure(id) : null;
    // An exposure of another owner is the same 404: a grant reaches only its own owner's agents.
    if (!e || e.owner !== tok.owner) return c.json({ error: "not_found" }, 404);
    const card = SdkAgentCard.fromJSON(exposureCard(deps.cfg, id, e.card));
    const handler = new DefaultRequestHandler(card, tasks, executorFor(tok, id, e.deviceId));
    const body: unknown = await c.req.json().catch(() => null);
    const context = new ServerCallContext({
      user: new GrantUser(`${tok.owner}/${tok.cid}`),
      requestedVersion: c.req.header("a2a-version") ?? A2A_PROTOCOL_VERSION,
    });
    const out = await new JsonRpcTransportHandler(handler).handle(
      body && typeof body === "object" ? (body as Record<string, unknown>) : "",
      context,
    );
    if (Symbol.asyncIterator in out) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          for await (const r of out) ctl.enqueue(enc.encode(`data: ${JSON.stringify(r)}\n\n`));
          ctl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return c.json(out);
  });
  return app;
};
