import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  McpServer,
  OAuthError,
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { fromB64url, sealJson } from "@chalito/crypto";
import { GatewayApiError, type GatewayApi } from "./api-client.js";
import { MCP_SCOPES, type GatewayReader, type GatewayToken, type McpScope } from "./reader.js";

/**
 * Chalito's MCP gateway (ADR 0009, MCP 2026-07-28, Streamable HTTP). A protected resource for
 * Chalito's OAuth server: every request's bearer token is looked up (hashed) in the database, so a
 * revoked grant stops working on the very next call. The database role is read-only; writes go
 * through the api. No tool can approve anything: decisions are signed on the person's phone.
 */
export interface GatewayConfig {
  /** This gateway's resource URL (the tokens' audience), e.g. https://mcp.chalito.chalyb.com/mcp */
  resource: string;
  /** The authorization server (the api's issuer). */
  issuer: string;
}

export interface GatewayDeps {
  reader: GatewayReader;
  api: GatewayApi;
  cfg: GatewayConfig;
  now: () => number;
}

const MAX_PROMPT = 8000;
const MAX_POST = 4000;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const toolError = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const apiError = (err: unknown) => {
  if (err instanceof GatewayApiError) return toolError(`Chalito refused: ${err.code}`);
  throw err;
};

const tokenOf = (authInfo: AuthInfo | undefined): GatewayToken & { raw: string } => {
  const t = authInfo?.extra?.chalito as GatewayToken | undefined;
  if (!authInfo || !t) throw new OAuthError("invalid_token", "missing token");
  return { ...t, raw: authInfo.token };
};

/** One McpServer per request, with only the tools the grant's scopes allow. */
export const buildServer = (deps: GatewayDeps, authInfo: AuthInfo | undefined): McpServer => {
  const tok = tokenOf(authInfo);
  const has = (s: McpScope) => tok.scopes.includes(s);
  const origin = `mcp:${tok.provider}`;
  const server = new McpServer(
    { name: "chalito", version: "0.1.0" },
    {
      instructions:
        "Chalito shows the person's coding-agent sessions and pending approvals. You can recommend, " +
        "never decide: every approval is signed by the person on their phone.",
    },
  );

  if (has("mcp:read")) {
    server.registerTool(
      "list_pending",
      {
        description:
          "List approvals waiting for the person's decision (metadata: risk, kind, session, expiry). " +
          "Details stay end-to-end encrypted; a session's card is included only if the person shared it.",
        inputSchema: z.object({}),
      },
      async () => {
        const rows = await deps.reader.pending(tok.owner, deps.now());
        const cards = new Map<string, Record<string, unknown> | null>();
        for (const sid of new Set(rows.map((r) => r.sid))) cards.set(sid, await deps.reader.sharedCard(tok.owner, sid));
        await deps.api.audit(tok.raw, { tool: "list_pending" }).catch(() => undefined);
        return json({
          pending: rows.map((r) => ({ ...r, ...(cards.get(r.sid) ? { sessionCard: cards.get(r.sid) } : {}) })),
        });
      },
    );

    server.registerTool(
      "get_session_card",
      {
        description:
          "A session's status. The card (goal, last action, open question, tests) is returned only if " +
          "the person turned on sharing for that session or device; otherwise metadata only.",
        inputSchema: z.object({ sid: z.string().min(1).max(128) }),
      },
      async ({ sid }) => {
        const meta = await deps.reader.session(tok.owner, sid);
        if (!meta) return toolError("No such session.");
        const card = await deps.reader.sharedCard(tok.owner, sid);
        await deps.api.audit(tok.raw, { tool: "get_session_card", target: sid }).catch(() => undefined);
        return json(card ? { ...meta, shared: true, card } : { ...meta, shared: false });
      },
    );
  }

  if (has("mesa:post")) {
    server.registerTool(
      "post_to_mesa",
      {
        description: "Post a message to the person's Mesa. It is encrypted to their devices before it leaves here.",
        inputSchema: z.object({ text: z.string().min(1).max(MAX_POST) }),
      },
      async ({ text }) => {
        const keys = await deps.reader.clientBoxKeys(tok.owner);
        if (Object.keys(keys).length === 0) return toolError("The person has no client devices to post to.");
        const recipients: Record<string, Uint8Array> = {};
        for (const [id, k] of Object.entries(keys)) recipients[id] = await fromB64url(k);
        const mid = "mcp_inbox";
        const ct = await sealJson({ v: 1, origin, text, at: deps.now() }, recipients, `mesa:${mid}`);
        try {
          const r = await deps.api.mesaTurn(tok.raw, { mid, ct });
          return json({ posted: true, tid: r?.tid });
        } catch (err) {
          return apiError(err);
        }
      },
    );
  }

  if (has("approval:recommend")) {
    server.registerTool(
      "recommend_decision",
      {
        description:
          "Recommend approving or denying a pending approval. Advisory only: the person still decides " +
          "and signs on their phone.",
        inputSchema: z.object({
          aid: z.string().min(1).max(128),
          recommendation: z.enum(["approve", "deny"]),
          reason: z.string().max(500).default(""),
        }),
      },
      async ({ aid, recommendation, reason }) => {
        try {
          await deps.api.recommend(tok.raw, { aid, allow: recommendation === "approve", note: reason });
          return json({ recorded: true, advisory: true });
        } catch (err) {
          return apiError(err);
        }
      },
    );
  }

  if (has("session:prompt")) {
    server.registerTool(
      "prompt_session",
      {
        description:
          "Send a prompt to one of the person's agent sessions. Anything risky the agent then wants to " +
          "do still waits for the person's signed approval.",
        inputSchema: z.object({ sid: z.string().min(1).max(128), prompt: z.string().min(1).max(MAX_PROMPT) }),
      },
      async ({ sid, prompt }) => {
        const agent = await deps.reader.sessionAgent(tok.owner, sid);
        if (!agent) return toolError("No running agent for that session.");
        const cid = `mcp_${randomUUID().replace(/-/g, "")}`;
        // Sealed here, to the agent's key only: the api and database see ciphertext.
        const promptCt = await sealJson(prompt, { [agent.deviceId]: await fromB64url(agent.pubBox) }, `command:${cid}`);
        try {
          await deps.api.prompt(tok.raw, { cid, sid, promptCt });
          return json({ sent: true, cid });
        } catch (err) {
          return apiError(err);
        }
      },
    );
  }

  return server;
};

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const createGateway = (deps: GatewayDeps) => {
  const resourceUrl = new URL(deps.cfg.resource);
  const prmUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
  const gate = requireBearerAuth({
    verifier: {
      // Every request: hash, look up, check the grant. Revocation is immediate.
      verifyAccessToken: async (token) => {
        const t = await deps.reader.accessToken(sha256hex(token), deps.now());
        if (!t) throw new OAuthError("invalid_token", "unknown, expired or revoked token");
        return {
          token,
          clientId: t.clientId,
          scopes: t.scopes,
          expiresAt: Math.floor(t.expiresAt / 1000),
          resource: new URL(t.resource),
          extra: { chalito: t },
        };
      },
    },
    expectedResource: resourceUrl,
    resourceMetadataUrl: prmUrl,
  });
  const handler = createMcpHandler(({ authInfo }) => buildServer(deps, authInfo));

  // RFC 9728 Protected Resource Metadata.
  const prm = () => ({
    resource: deps.cfg.resource,
    authorization_servers: [deps.cfg.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Chalito",
  });
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(prm()));
  app.get(`/.well-known/oauth-protected-resource${resourceUrl.pathname}`, (c) => c.json(prm()));
  app.all(resourceUrl.pathname, async (c) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    return handler.fetch(c.req.raw, { authInfo: auth });
  });
  return app;
};
