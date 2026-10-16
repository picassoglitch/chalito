/**
 * What the gateway reads, over its READ-ONLY database role (chalito_gateway, D-035). It never
 * writes: post_to_mesa, recommend_decision and prompt_session go through the api.
 */
export const MCP_SCOPES = ["mcp:read", "mesa:post", "approval:recommend", "session:prompt", "link:handoff"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface GatewayToken {
  owner: string;
  /** The grant (connector) id. */
  cid: string;
  clientId: string;
  provider: "claude" | "chatgpt" | "other";
  scopes: McpScope[];
  resource: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface PendingApproval {
  aid: string;
  sid: string;
  deviceId: string;
  kind: "tool" | "decision" | "computer_control" | "terminal";
  risk: "LOW" | "MED" | "HIGH" | "CRITICAL";
  origin: string;
  stepUpRequired: boolean;
  createdAt: number;
  expiresAt: number;
  recommendations: number;
}

export interface SessionMeta {
  sid: string;
  deviceId: string;
  deviceName: string | null;
  adapter: string | null;
  state: string | null;
  updatedAt: number | null;
}

/** One of the owner's agents (an app that runs sessions) on one device, for `list_agents`. Status only. */
export interface AgentSummary {
  appId: string;
  deviceId: string;
  deviceName: string | null;
  /** The recipe kind that runs it (claude-sdk, codex, acp, chat-api, a2a). */
  kind: string;
  state: string;
}

/** An agent the owner exposes on the A2A server (chalito.a2a_exposures). */
export interface ExposureRow {
  owner: string;
  exposureId: string;
  appId: string;
  deviceId: string;
  /** The card body (packages/protocol AgentCard without interfaces or security). */
  card: Record<string, unknown>;
}

export interface GatewayReader {
  /** A live (unexpired, unrevoked-grant) ACCESS token by its SHA-256, or null. Checked on every call. */
  accessToken(tokenHash: string, now: number): Promise<GatewayToken | null>;
  pending(owner: string, now: number): Promise<PendingApproval[]>;
  session(owner: string, sid: string): Promise<SessionMeta | null>;
  /** The plaintext card, only while sharing is on for that session or its device. */
  sharedCard(owner: string, sid: string): Promise<Record<string, unknown> | null>;
  /** Box keys (b64url) of the owner's active client devices: who can read a Mesa post. */
  clientBoxKeys(owner: string): Promise<Record<string, string>>;
  /** The active agent running a session and its box key (b64url). */
  sessionAgent(owner: string, sid: string): Promise<{ deviceId: string; pubBox: string } | null>;
  /** The owner's agent apps (linkable kinds) on their active agent devices. */
  agents(owner: string): Promise<AgentSummary[]>;
  /** An active agent device's box key (b64url), to seal a task's prompt to it. */
  agentBoxKey(owner: string, deviceId: string): Promise<string | null>;
  /** A live exposure by id (any owner; the caller checks the token's owner). */
  exposure(exposureId: string): Promise<ExposureRow | null>;
}
