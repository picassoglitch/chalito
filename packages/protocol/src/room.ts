import { z } from "zod";
import { b64url, CompanionId, DeviceId, EpochMs, Id, RoomId, Uid, Urgency } from "./common.js";
import { RoomSealed } from "./crypto.js";

export const RoomType = z.enum(["family", "business", "project"]);

/** Allowed TTL values come from packages/config/rooms.yaml; `until_dissolved` keeps events until the room ends. */
export const EphemeralTtl = z.union([z.string().regex(/^P(T\d+H|\d+D)$/), z.literal("until_dissolved")]);

export const RoomRetention = z.object({
  ephemeralTtl: EphemeralTtl,
  keepPromoted: z.boolean(),
});

export const Room = z.object({
  v: z.literal(1),
  roomId: RoomId,
  type: RoomType,
  name: z.string().min(1).max(60),
  ownerUid: Uid,
  ownerCompanionId: CompanionId,
  retention: RoomRetention,
  keyEpoch: z.number().int().positive(),
  memberCount: z.number().int().nonnegative(),
  status: z.enum(["active", "dissolving"]),
  createdAt: EpochMs,
});
export type Room = z.infer<typeof Room>;

export const RoomMember = z.object({
  v: z.literal(1),
  companionId: CompanionId,
  uid: Uid,
  role: z.enum(["owner", "member"]),
  joinedAt: EpochMs,
  /** deviceId → room key for `epoch`, sealed to that device's X25519 key. */
  wrappedKeys: z.record(DeviceId, z.object({ epoch: z.number().int().positive(), ct: b64url(80) })),
  presence: z.object({ state: z.enum(["online", "away", "busy", "offline"]), at: EpochMs }),
  shareUrgency: z.boolean(),
});
export type RoomMember = z.infer<typeof RoomMember>;

export const RoomEventKind = z.enum(["notice", "event_proposal", "ask", "ack", "enter", "leave", "presence"]);
export type RoomEventKind = z.infer<typeof RoomEventKind>;

/**
 * `rooms/{roomId}/roomEvents/{eid}`. Content is sealed with the room key.
 * `to` empty = everyone; only addressed companions process it.
 */
export const RoomEvent = z.object({
  v: z.literal(1),
  roomId: RoomId,
  eid: Id,
  fromCompanionId: CompanionId,
  to: z.array(CompanionId).max(50),
  kind: RoomEventKind,
  urgency: Urgency,
  ct: RoomSealed,
  keyEpoch: z.number().int().positive(),
  promoted: z.boolean(),
  promotedBy: z.array(CompanionId),
  t: EpochMs,
  /** Null when promoted with keepPromoted, or when retention is until_dissolved. */
  expireAt: EpochMs.nullable(),
});
export type RoomEvent = z.infer<typeof RoomEvent>;

/**
 * Decrypted room-event body. Data and notifications only: there is no kind that
 * carries an instruction, command or prompt. Receiving companions may only PROPOSE
 * an action to their own human; text fields are rendered as quoted data, never as
 * model instructions.
 */
export const RoomEventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notice"), text: z.string().max(500) }),
  z.object({
    kind: z.literal("event_proposal"),
    title: z.string().max(120),
    when: z.string().datetime({ offset: true }).optional(),
    where: z.string().max(160).optional(),
    note: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal("ask"),
    question: z.string().max(300),
    options: z.array(z.string().max(80)).min(2).max(6),
  }),
  z.object({ kind: z.literal("ack"), ref: Id, choice: z.number().int().min(0).max(5).optional() }),
  z.object({ kind: z.literal("enter") }),
  z.object({ kind: z.literal("leave") }),
  z.object({
    kind: z.literal("presence"),
    state: z.enum(["online", "away", "busy", "offline"]),
    urgencyBadge: Urgency.optional(),
  }),
]);
export type RoomEventBody = z.infer<typeof RoomEventBody>;

/** `roomInvites/{inviteId}`. The glyph/short code is never stored in clear, only hashed. */
export const RoomInvite = z.object({
  v: z.literal(1),
  inviteId: Id,
  roomId: RoomId,
  createdByCompanionId: CompanionId,
  glyphPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  shortCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  maxUses: z.number().int().positive().default(1),
  uses: z.number().int().nonnegative(),
  claimedBy: z.array(CompanionId),
  expiresAt: EpochMs,
});
export type RoomInvite = z.infer<typeof RoomInvite>;

// ---- api requests (apps/api/src/routes/rooms.ts) ------------------------------------------
// Every write goes through the api, which acts for a verified client device and its owner's
// companion. Content stays sealed with the room key; the api never sees plaintext.

/** deviceId → the room key for one epoch, sealed to that device (crypto_box_seal, 80 bytes). */
export const WrappedKeys = z
  .record(DeviceId, b64url(80))
  .refine((k) => Object.keys(k).length <= 20, "at most 20 devices");

export const CreateRoomRequest = z.object({
  roomId: RoomId,
  type: RoomType,
  name: z.string().min(1).max(60),
  companionId: CompanionId,
  /** Epoch 1, wrapped by the creator's client to its owner's client devices. */
  wrappedKeys: WrappedKeys,
});

/** The inviting member's client signs a `room_invite` glyph (codeId = inviteId); the api stores hashes. */
export const CreateRoomInviteRequest = z.object({
  companionId: CompanionId,
  glyph: z.object({ body: z.record(z.string(), z.unknown()), sig: z.string() }),
  maxUses: z.number().int().min(1).max(50).default(1),
});

export const JoinRoomRequest = z
  .object({
    companionId: CompanionId,
    shortCode: z.string().min(8).max(20).optional(),
    glyph: z.object({ body: z.record(z.string(), z.unknown()), sig: z.string() }).optional(),
  })
  .refine((r) => !!r.shortCode !== !!r.glyph, { message: "exactly one of shortCode or glyph" });

export const WrapRoomKeysRequest = z.object({
  companionId: CompanionId,
  /** The member whose devices receive the key. */
  targetCompanionId: CompanionId,
  epoch: z.number().int().positive(),
  wrappedKeys: WrappedKeys,
});

export const RotateRoomKeyRequest = z.object({
  companionId: CompanionId,
  epoch: z.number().int().positive(),
  /** companionId → deviceId → sealed key, for exactly the remaining members. */
  wrappedKeys: z.record(CompanionId, WrappedKeys),
});

export const RoomActorRequest = z.object({ companionId: CompanionId });

export const PostRoomEventRequest = z.object({
  eid: Id,
  companionId: CompanionId,
  to: z.array(CompanionId).max(50).default([]),
  kind: RoomEventKind,
  urgency: Urgency.default("low"),
  ct: RoomSealed,
  keyEpoch: z.number().int().positive(),
});

export const PromoteRoomEventRequest = z.object({
  companionId: CompanionId,
  rid: Id,
  kind: z.enum(["reminder", "decision", "transcript", "note"]),
  /** The actor's durable copy, sealed to their own devices by their client. */
  ct: z.record(z.string(), z.unknown()),
});

export const SetRoomRetentionRequest = z.object({ companionId: CompanionId, retention: RoomRetention });

/**
 * POST /v1/rooms/:roomId/reports: a member reports an event and/or another member. Deduped per
 * reporter and target (a repeat returns the same reportId). `attachedPlaintext` is the reporter's
 * own decrypted copy of the event, sent only when they explicitly choose to attach it.
 */
export const RoomReportReason = z.enum(["spam", "abuse", "impersonation", "other"]);
export const RoomReportRequest = z
  .object({
    companionId: CompanionId,
    eventId: Id.optional(),
    memberCompanionId: CompanionId.optional(),
    reason: RoomReportReason,
    note: z.string().max(500).optional(),
    attachedPlaintext: z.string().min(1).max(4000).optional(),
    /** Must be true when attachedPlaintext is present: the reporter opted in to send it. */
    attachPlaintext: z.boolean().optional(),
  })
  .refine((r) => r.eventId !== undefined || r.memberCompanionId !== undefined, {
    message: "report an event or a member",
  })
  .refine((r) => r.attachedPlaintext === undefined || r.attachPlaintext === true, {
    message: "attachedPlaintext needs attachPlaintext: true (an explicit opt-in)",
  })
  .refine((r) => r.attachedPlaintext === undefined || r.eventId !== undefined, {
    message: "attachedPlaintext is the reported event's text",
  });
export type RoomReportRequest = z.infer<typeof RoomReportRequest>;
export const RoomReportResponse = z.object({ reportId: Id, duplicate: z.boolean() });
export type RoomReportResponse = z.infer<typeof RoomReportResponse>;
