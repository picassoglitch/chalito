import { z } from "zod";
import { DeviceId, EpochMs, Id, Origin, PubBox, PubSign, RemotePermissionMode, SessionId } from "./common.js";
import { SealedEnvelope } from "./crypto.js";
import { LinkArtifact, LinkTaskState } from "./link.js";
import { AppId } from "./recipe.js";

/**
 * Agent-to-agent links (ADR 0022 §3). A link is an owner-made, explicit permission for one
 * agent to reach another; there are none by default.
 *
 * - `share`: the sender may send information (a status, a result, a file reference). The
 *   receiver sees it as a quoted data block with the Rooms hygiene (ADR 0010); it never starts or
 *   steers a prompt. Any trusted client can create one, with a passkey step-up.
 * - `handoff`: the sender may ask the receiver to do work (a `LinkTask`). The receiver gets a
 *   turn with origin `agent:<senderSid>`, wrapped in a fixed frame naming the sender, the link
 *   and the owner's goal. It loosens policy, so it is created **only locally** on the device
 *   (desktop panel or `chalito link add`), like Developer mode (ADR 0008).
 *
 * Every hand-off is relayed (never signed by a person's key): the origin is never eligible for
 * Developer-mode auto-approve, the tool gate runs as for any other turn, and the receiving
 * session's permission mode is at most the link's ceiling, which is at most local policy.
 */

// ---------------------------------------------------------------- shared interface (Phase D)

/** What a link lets the sender do. */
export type LinkMode = "share" | "handoff";
export const LinkMode = z.enum(["share", "handoff"]);

/**
 * One delivery over a link, as the receiving side sees it. `hop` counts the hand-offs so far,
 * including this one (A → B is 1, B → C is 2); `chain` lists the sessions the task went through
 * (the sender's last).
 */
export interface LinkAuthorizeRequest {
  origin: Origin;
  fromAgent: string;
  toAgent: string;
  targetDeviceId: string;
  cwd?: string;
  hop: number;
  chain: string[];
}

export type LinkAuthorizeResult =
  | { ok: true; linkId: string; mode: LinkMode; confirm: boolean; permissionCeiling: RemotePermissionMode }
  | { ok: false; reason: string };

/** Decides whether a delivery may go over a link. Phase D codes against this. */
export interface LinkAuthorizer {
  authorize(req: LinkAuthorizeRequest): Promise<LinkAuthorizeResult>;
}

/** The default: no links, so nothing is authorized. */
export const denyAllLinkAuthorizer: LinkAuthorizer = {
  authorize: async () => ({ ok: false, reason: "no_link" }),
};

// ---------------------------------------------------------------- limits

/** A task stops after 2 hand-offs (A → B → C). */
export const LINK_MAX_HOPS = 2 as const;
/** A link lives at most 30 days; the owner makes a new one after that. */
export const LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Ceiling on the rate the owner may set (deliveries per link per hour). */
export const LINK_MAX_RATE_PER_HOUR = 60;
/** Ceiling on the daily token budget the owner may set (per link, UTC day). */
export const LINK_MAX_DAILY_TOKENS = 10_000_000;

// ---------------------------------------------------------------- the link

export const LinkId = z.string().regex(/^lnk_[A-Za-z0-9_-]{8,64}$/, "link ids are lnk_ + 8..64 id chars");
export type LinkId = z.infer<typeof LinkId>;

/**
 * One end of a link. `sessionId` pins a live session (a hand-off then prompts it); without one,
 * each hand-off starts a new session of `appId` in the link's workspace. For a cross-device link
 * each end's keys are recorded locally when the link is made: relays are verified against
 * `pubSign` and sealed to `pubBox`, never against keys read from the cloud.
 */
export const LinkEndpoint = z
  .object({
    deviceId: DeviceId,
    sessionId: SessionId.optional(),
    appId: AppId.optional(),
    pubSign: PubSign.optional(),
    pubBox: PubBox.optional(),
  })
  .strict();
export type LinkEndpoint = z.infer<typeof LinkEndpoint>;

const LinkFields = z
  .object({
    v: z.literal(1),
    id: LinkId,
    mode: LinkMode,
    sender: LinkEndpoint,
    receiver: LinkEndpoint,
    /** The receiver's working scope: a workspace label from its local policy, never a raw path. */
    workspaceLabel: z.string().min(1).max(80),
    /** The owner's goal for the link, shown in the hand-off frame (quoted, never as instructions). */
    goal: z.string().min(1).max(500),
    expiresAt: EpochMs,
    /** Tokens (in + out) the receiver may spend on this link's tasks per UTC day. */
    dailyTokenBudget: z.number().int().min(1).max(LINK_MAX_DAILY_TOKENS),
    /** Deliveries (hand-offs or shares) per hour. */
    ratePerHour: z.number().int().min(1).max(LINK_MAX_RATE_PER_HOUR),
    /** "Ask me each time": one tap on the phone before each hand-off is delivered (the default). */
    confirm: z.boolean().default(true),
    /** Highest permission mode a receiving session gets; local policy still caps it. */
    permissionCeiling: RemotePermissionMode.default("default"),
    createdAt: EpochMs,
    /** `local` for every hand-off link; a `client:<id>` (with step-up) may only make share links. */
    createdBy: Origin,
  })
  .strict();

const crossDeviceKeys = (l: { sender: LinkEndpoint; receiver: LinkEndpoint }) =>
  l.sender.deviceId === l.receiver.deviceId ||
  (l.sender.pubSign !== undefined &&
    l.sender.pubBox !== undefined &&
    l.receiver.pubSign !== undefined &&
    l.receiver.pubBox !== undefined);

export const AgentLink = LinkFields.refine((l) => l.expiresAt > l.createdAt, {
  message: "a link expires after it is made",
})
  .refine((l) => l.expiresAt - l.createdAt <= LINK_MAX_TTL_MS, { message: "a link lives at most 30 days" })
  .refine((l) => l.mode !== "handoff" || l.createdBy === "local", {
    message: "hand-off links are made only locally on the device",
  })
  .refine((l) => l.createdBy === "local" || l.createdBy.startsWith("client:"), {
    message: "links are made locally or by a trusted client",
  })
  .refine(crossDeviceKeys, { message: "a cross-device link records both ends' keys" })
  .refine((l) => l.sender.sessionId === undefined || l.sender.sessionId !== l.receiver.sessionId, {
    message: "a session can't link to itself",
  });
export type AgentLink = z.infer<typeof AgentLink>;

/**
 * What `link.create` carries from a trusted client: a **share** link only. A hand-off link is
 * unrepresentable here; the agent also reports such an attempt as `remote_enable.rejected`.
 */
export const LinkCreateSpec = LinkFields.omit({ v: true, createdAt: true, createdBy: true })
  .extend({ mode: z.literal("share") })
  .refine(crossDeviceKeys, { message: "a cross-device link records both ends' keys" });
export type LinkCreateSpec = z.infer<typeof LinkCreateSpec>;

/** The metadata a link shows in plaintext (phone list, cloud mirror). Goal and scope travel sealed. */
export const AgentLinkSummary = z.object({
  v: z.literal(1),
  id: LinkId,
  mode: LinkMode,
  senderDeviceId: DeviceId,
  receiverDeviceId: DeviceId,
  confirm: z.boolean(),
  permissionCeiling: RemotePermissionMode,
  expiresAt: EpochMs,
  revokedAt: EpochMs.nullable(),
});
export type AgentLinkSummary = z.infer<typeof AgentLinkSummary>;

// ---------------------------------------------------------------- commands

/** Commands a trusted client (or the device itself) sends about links. */
export const LinkCommands = [
  /** A share link, with the signer's passkey step-up over this command. */
  z.object({ type: z.literal("link.create"), link: LinkCreateSpec }),
  /** Revoke one link, or every link on the device. Works from any trusted client, at once. */
  z.object({ type: z.literal("link.revoke"), linkId: LinkId }),
  z.object({ type: z.literal("link.revokeAll") }),
  /** Re-publishes this device's links (summaries, details sealed) for the person's clients. */
  z.object({ type: z.literal("link.list") }),
] as const;

/**
 * What one agent relays to another over a link (`relayedBy: "agent-link"`, origin
 * `agent:<sid>`, signed with the sending agent's device key under `chalito.link.v1`). The sealed
 * parts open on the receiving agent only (AAD `command:<cid>`).
 * - `link.handoff`: a task. `taskCt` opens to a `LinkMessage` (ROLE_USER) with the request.
 * - `link.share`: information. `dataCt` opens to a `LinkMessage` (ROLE_AGENT).
 * - `link.result`: a task's outcome back to its sender. `resultCt` opens to a `LinkResult`.
 */
export const LinkRelayCommands = [
  z.object({
    type: z.literal("link.handoff"),
    linkId: LinkId,
    taskId: Id,
    hop: z
      .number()
      .int()
      .min(1)
      .max(LINK_MAX_HOPS + 1),
    chain: z
      .array(SessionId)
      .min(1)
      .max(LINK_MAX_HOPS + 1),
    taskCt: SealedEnvelope,
  }),
  z.object({ type: z.literal("link.share"), linkId: LinkId, dataCt: SealedEnvelope }),
  z.object({ type: z.literal("link.result"), linkId: LinkId, taskId: Id, resultCt: SealedEnvelope }),
] as const;
export const LINK_RELAY_TYPES = ["link.handoff", "link.share", "link.result"] as const;

/** Why a hand-off or share didn't go through (audit, phone and `link.result`). */
export const LinkRefusal = z.enum([
  "no_link",
  "link_revoked",
  /** The link has no row in the cloud mirror yet (its publish failed): not delivered until it has one. */
  "link_unpublished",
  "link_expired",
  "wrong_mode",
  "wrong_endpoint",
  "bad_signature",
  "hop_limit",
  "cycle",
  "rate_limited",
  "budget_exhausted",
  "out_of_scope",
  "permission_above_ceiling",
  "receiver_busy",
  "owner_declined",
  "origin_disabled",
  "start_failed",
  // ADR 0031 §4: a transfer's project isn't the receiving workspace's (`origin` differs).
  "wrong_repo",
]);
export type LinkRefusal = z.infer<typeof LinkRefusal>;

/** What `link.result` opens to: the task's final state and its artifacts (quoted data at the sender). */
export const LinkResult = z.object({
  v: z.literal(1),
  taskId: Id,
  state: LinkTaskState,
  artifacts: z.array(LinkArtifact).max(16),
  reason: LinkRefusal.optional(),
});
export type LinkResult = z.infer<typeof LinkResult>;

/** Where a hand-off is, as the phone shows it (metadata only). */
export const LinkHandoffStage = z.enum([
  "sent",
  "confirm_pending",
  "delivered",
  "refused",
  "completed",
  "failed",
  "canceled",
]);
export type LinkHandoffStage = z.infer<typeof LinkHandoffStage>;
