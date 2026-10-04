/**
 * MCP connectors (M10, apps/api/src/routes/oauth.ts): the consent screen's request, the person's
 * grants ("Apps conectadas") and per-session/device card sharing. Approving consent and changing
 * sharing need a CLIENT device token (a paired device), plus a passkey assertion for consent.
 */
export interface ConsentScope {
  scope: string;
  es: string;
  en: string;
  defaultChecked: boolean;
}
export interface ConsentRequest {
  requestId: string;
  client: { name: string; id: string; redirectHost: string; provider: "claude" | "chatgpt" | "other" };
  scopes: ConsentScope[];
  expiresAt: number;
}
export interface Connector {
  cid: string;
  clientId: string;
  clientName: string;
  provider: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export type McpError = "not_found" | "no_passkey" | "passkey_failed" | "challenge_expired" | "forbidden" | "error";

export interface McpApi {
  getRequest(id: string): Promise<ConsentRequest | McpError>;
  approve(id: string, scopes: string[], assertion: Record<string, unknown>): Promise<{ redirect: string } | McpError>;
  deny(id: string): Promise<{ redirect: string } | McpError>;
  listConnectors(): Promise<Connector[] | McpError>;
  revoke(cid: string): Promise<true | McpError>;
  setSharing(t: {
    sessionId?: string;
    deviceId?: string;
    enabled: boolean;
    plaintextAck?: boolean;
  }): Promise<true | McpError>;
}

const asError = (status: number, code: string): McpError =>
  status === 404
    ? "not_found"
    : code === "no_passkey" || code === "passkey_failed" || code === "challenge_expired"
      ? code
      : status === 401 || status === 403
        ? "forbidden"
        : "error";

export const httpMcp = (apiBase: string, token: () => Promise<string | null>): McpApi => {
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | McpError> => {
    try {
      const t = await token();
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(t ? { authorization: `Bearer ${t}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: "omit",
      });
      if (res.status === 204) return true as T;
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? (json as T) : asError(res.status, json.error ?? "");
    } catch {
      return "error";
    }
  };
  const id = (s: string) => encodeURIComponent(s);
  return {
    getRequest: (r) => call("GET", `/oauth/requests/${id(r)}`),
    approve: (r, scopes, assertion) => call("POST", `/oauth/requests/${id(r)}/approve`, { scopes, assertion }),
    deny: (r) => call("POST", `/oauth/requests/${id(r)}/deny`, {}),
    listConnectors: async () => {
      const r = await call<{ connectors: Connector[] }>("GET", "/v1/connectors");
      return typeof r === "string" ? r : r.connectors;
    },
    revoke: (cid) => call("POST", `/v1/connectors/${id(cid)}/revoke`, {}),
    setSharing: (t) => call("POST", "/v1/mcp/sharing", t),
  };
};

/** Only https redirects (or loopback http for native clients) are followed after consent. */
export const safeOAuthRedirect = (u: string): string | null => {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return url.toString();
    if (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    )
      return url.toString();
    return null;
  } catch {
    return null;
  }
};
