import { z } from "zod";

/**
 * Delivery standard (docs/AI_TEAM.md): every peer pulls with team_read; a peer whose client declared a way
 * to be woken also gets new messages pushed through one adapter, chosen at join from that declaration.
 */
export type TeamKind = "status" | "request" | "result";
export interface TeamMessage {
  workspace: string;
  seq: number;
  from: string;
  provider: string;
  to?: string;
  kind: TeamKind;
  text: string;
  at: number;
}

/** One push: unread messages for one peer, oldest first. `more` stay unread for team_read. */
export interface TeamBatch {
  workspace: string;
  historyTruncated: boolean;
  more: number;
  messages: TeamMessage[];
}

export interface DeliveryPeer {
  id: string;
  provider: string;
  workspace: string;
}

export interface DeliveryAdapter {
  /** pull, mcp-channel, app-server, command; later acp, a2a. */
  readonly id: string;
  /** Can reach an idle session; false means the peer only gets messages by calling team_read. */
  readonly canWake: boolean;
  /** True once handed to the transport. False keeps the messages unread for the next try or team_read. */
  deliver(batch: TeamBatch, peer: DeliveryPeer): boolean;
}

/** What the MCP client told our server in `initialize`, forwarded by the mcp process (team_client). */
export const ClientDeclaration = z
  .object({
    name: z.string().max(128).optional(),
    version: z.string().max(64).optional(),
    /** Keys of the client's `capabilities.experimental`. */
    experimental: z.array(z.string().max(128)).max(32).default([]),
    /** The client loaded this server as a Claude Code channel (its launch flags name server:chalito_team). */
    channel: z.boolean().default(false),
  })
  .strict();
export type ClientDeclaration = z.infer<typeof ClientDeclaration>;

/** The live connection to the peer's mcp process; push returns false when it is gone. */
export interface DeliveryLink {
  push(frame: { teamDelivery: { adapter: string; batch: TeamBatch } }): boolean;
}

export interface DeliveryContext {
  provider: string;
  client: ClientDeclaration;
  link: DeliveryLink | null;
}

/** A link in the fallback chain: returns an adapter when this peer can use it, else null. */
export interface DeliveryFactory {
  readonly id: string;
  select(ctx: DeliveryContext): DeliveryAdapter | null;
}
