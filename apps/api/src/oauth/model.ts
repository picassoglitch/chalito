/** OAuth/MCP records (supabase/migrations/20261004001700_chalito_oauth.sql, 001800). */
export const MCP_SCOPES = ["mcp:read", "mesa:post", "approval:recommend", "session:prompt"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s);

export type Provider = "claude" | "chatgpt" | "other";

export interface OAuthClient {
  clientId: string;
  kind: "cimd" | "dcr";
  clientName: string;
  redirectUris: string[];
  metadata: Record<string, unknown>;
  fetchedAt: number | null;
}

export interface AuthorizationRequest {
  requestId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpScope[];
  state: string | null;
  resource: string;
  expiresAt: number;
}

export interface Grant {
  owner: string;
  cid: string;
  clientId: string;
  clientName: string;
  provider: Provider;
  scopes: McpScope[];
  resource: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CodeRecord {
  codeHash: string;
  owner: string;
  cid: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  expiresAt: number;
}

export interface TokenRecord {
  tokenHash: string;
  kind: "access" | "refresh";
  owner: string;
  cid: string;
  clientId: string;
  scopes: McpScope[];
  resource: string;
  expiresAt: number;
  usedAt: number | null;
}

/** A token with its grant, as the api and the gateway check it on every call. */
export interface TokenWithGrant extends TokenRecord {
  provider: Provider;
  grantRevokedAt: number | null;
}

/** Storage for the authorization server and the gateway's api writes. */
export interface McpStore {
  getClient(clientId: string): Promise<OAuthClient | null>;
  putClient(c: OAuthClient): Promise<void>;
  putRequest(r: AuthorizationRequest): Promise<void>;
  getRequest(requestId: string, now: number): Promise<AuthorizationRequest | null>;
  /** Deletes the request; false if it was already gone (single use: one approval or denial wins). */
  deleteRequest(requestId: string): Promise<boolean>;

  createGrant(g: Grant): Promise<void>;
  listGrants(owner: string): Promise<Grant[]>;
  /** Revokes the grant and deletes its codes and tokens. False if there was none. */
  revokeGrant(owner: string, cid: string, at: number): Promise<boolean>;
  touchGrant(owner: string, cid: string, at: number): Promise<void>;

  putCode(c: CodeRecord): Promise<void>;
  /** Single use: returns the code and deletes it; null if unknown or expired. */
  takeCode(codeHash: string, now: number): Promise<CodeRecord | null>;

  putToken(t: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenWithGrant | null>;
  /** Marks a refresh token used, atomically: "reused" if it was used before. */
  useRefresh(tokenHash: string, at: number): Promise<"ok" | "reused" | "missing">;
  deleteToken(tokenHash: string): Promise<void>;

  /** Appends an advisory recommendation to a pending approval (max 20). */
  recommend(
    owner: string,
    aid: string,
    rec: { from: string; allow: boolean; note: string; at: number },
  ): Promise<"ok" | "not_found" | "full">;
  /** Stores an MCP turn (sealed to the owner's clients) in the owner's Mesa inbox (M9 stub). */
  insertMesaTurn(owner: string, mid: string, tid: string, doc: Record<string, unknown>): Promise<void>;
  /** The device that runs a session (for prompt_session). */
  sessionDevice(owner: string, sid: string): Promise<string | null>;
  /** Inserts a relayed command for one agent (server write). "exists": that command id is taken. */
  insertCommand(
    owner: string,
    targetDeviceId: string,
    id: string,
    env: unknown,
    expiresAt: number,
  ): Promise<"ok" | "no_device" | "exists">;
  setSharing(
    owner: string,
    scope: "session" | "device",
    target: string,
    enabled: boolean,
    ackAt: number | null,
  ): Promise<void>;
}
