import { generateBoxKeyPair, toB64url, type BoxKeyPair } from "@chalito/crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GatewayApi } from "../src/api-client.js";
import { createGateway } from "../src/app.js";
import type { GatewayReader, McpScope, PendingApproval, SessionMeta } from "../src/reader.js";
import { GATEWAY_TOKEN, ISSUER, RESOURCE, oauthHarness } from "../../api/test/oauth-harness.js";

/**
 * The gateway wired to the api's OAuth server (in memory): the reader sees the api's token store,
 * so revocation through the api is visible to the gateway on its next call, as with the database.
 */
export const gatewayHarness = async () => {
  let skew = 0;
  const h = await oauthHarness({ now: () => Date.now() + skew });
  const phoneBox: BoxKeyPair = await generateBoxKeyPair();
  const data = {
    pending: [] as PendingApproval[],
    sessions: new Map<string, SessionMeta>(),
    cards: new Map<string, { deviceId: string; card: Record<string, unknown> }>(),
    clients: { [h.phone.deviceId]: await toB64url(phoneBox.publicKey) } as Record<string, string>,
    agents: new Map<string, { deviceId: string; pubBox: string }>(),
  };
  const sharingOn = (owner: string, sid: string, device: string) =>
    !!h.mcp.sharing.get(`${owner}/session/${sid}`)?.enabled ||
    !!h.mcp.sharing.get(`${owner}/device/${device}`)?.enabled;
  const reader: GatewayReader = {
    accessToken: async (hash, now) => {
      const t = await h.mcp.getToken(hash);
      if (!t || t.kind !== "access" || t.expiresAt <= now || t.grantRevokedAt !== null) return null;
      return {
        owner: t.owner,
        cid: t.cid,
        clientId: t.clientId,
        provider: t.provider,
        scopes: t.scopes as McpScope[],
        resource: t.resource,
        expiresAt: t.expiresAt,
      };
    },
    pending: async (owner) => (owner === h.o ? data.pending : []),
    session: async (owner, sid) => (owner === h.o ? (data.sessions.get(sid) ?? null) : null),
    sharedCard: async (owner, sid) => {
      const c = owner === h.o ? data.cards.get(sid) : undefined;
      return c && sharingOn(owner, sid, c.deviceId) ? c.card : null;
    },
    clientBoxKeys: async (owner) => (owner === h.o ? data.clients : {}),
    sessionAgent: async (owner, sid) => (owner === h.o ? (data.agents.get(sid) ?? null) : null),
  };
  const api = new GatewayApi("http://api.test", GATEWAY_TOKEN, ((url: string | URL, init?: RequestInit) =>
    h.app.request(url.toString(), init)) as typeof fetch);
  const gw = createGateway({ reader, api, cfg: { resource: RESOURCE, issuer: ISSUER }, now: h.deps.now });
  const gwFetch = ((url: string | URL, init?: RequestInit) => gw.fetch(new Request(url, init))) as typeof fetch;

  const mcpClient = async (accessToken: string) => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: gwFetch,
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    return c;
  };
  /** The text of a tool result, parsed. */
  const result = (r: unknown) => {
    const x = r as { isError?: boolean; content: { type: string; text: string }[] };
    const text = x.content[0]?.text ?? "";
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { isError: !!x.isError, value: value as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  return { ...h, data, reader, gw, gwFetch, mcpClient, result, phoneBox, skew: (ms: number) => (skew += ms) };
};
