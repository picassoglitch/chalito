import type { Origin, RemotePermissionMode } from "@chalito/protocol";

/**
 * The link authorizer (ADR 0022 §3/§4). Phase C (`m16c-links`) defines it in
 * `packages/protocol/src/agent-link.ts`; until that lands, this is an identical local copy.
 * Everything that lets an outside caller create work (the MCP gateway's `create_task`, the A2A
 * server's `SendMessage`) goes through one, and the default refuses everything.
 */
// TODO(m16c): import from @chalito/protocol agent-link
export type LinkMode = "share" | "handoff";
// TODO(m16c): import from @chalito/protocol agent-link
export interface LinkAuthorizeRequest {
  origin: Origin;
  fromAgent: string;
  toAgent: string;
  targetDeviceId: string;
  cwd?: string;
  hop: number;
  chain: string[];
}
// TODO(m16c): import from @chalito/protocol agent-link
export type LinkAuthorizeResult =
  | { ok: true; linkId: string; mode: LinkMode; confirm: boolean; permissionCeiling: RemotePermissionMode }
  | { ok: false; reason: string };
// TODO(m16c): import from @chalito/protocol agent-link
export interface LinkAuthorizer {
  authorize(req: LinkAuthorizeRequest): Promise<LinkAuthorizeResult>;
}
// TODO(m16c): import from @chalito/protocol agent-link
export const denyAllLinkAuthorizer: LinkAuthorizer = {
  authorize: async () => ({ ok: false, reason: "no_link" }),
};
