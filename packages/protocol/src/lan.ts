import { z } from "zod";
import { b64url, DeviceId, EpochMs, Id, PubSign, Signature } from "./common.js";
import { AgentEvent } from "./agentEvent.js";
import { SignedCommand } from "./command.js";

/**
 * LAN direct path (ADR 0022 §5, M16 phase E): two agents of the same owner on one network reach
 * each other without the cloud. The wire is a local WebSocket; this file fixes its shapes.
 *
 * The LAN link is a transport, never a trust root. What it carries is exactly what the cloud
 * path carries (signed commands, sealed events), verified the same way by the receiver.
 */

/** mDNS service type. Instances are opaque, rotating ids (lanAdvertId in @chalito/crypto). */
export const LAN_SERVICE_TYPE = "_chalito._tcp";
/** WebSocket path on the agent's LAN listener. */
export const LAN_WS_PATH = "/chalito-lan/v1";
/** Ceiling for one LAN message (a sealed event or a signed command; screens never ride it). */
export const LAN_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Tokens live at most this long (the SQL clamps it too, migration 20261015000500). */
export const LAN_TOKEN_MAX_TTL_MS = 15 * 60 * 1000;

/** A short-lived, cloud-issued LAN pairing token (one per owner per window; `secret` never leaves the owner's agents). */
export const LanToken = z.object({
  /** Opaque token id (16 random bytes), sent in the clear in the first handshake message. */
  tid: b64url(16),
  /** 32 random bytes, mixed into the session keys: only holders of this owner's token can finish a handshake. */
  secret: b64url(32),
  expiresAt: EpochMs,
});
export type LanToken = z.infer<typeof LanToken>;

/** Another agent of the same owner, as the cloud's directory lists it (checked against the key on the wire). */
export const LanPeer = z.object({ deviceId: DeviceId, pubSign: PubSign });
export type LanPeer = z.infer<typeof LanPeer>;

/** What `chalito.lan_token()` returns, mapped to camelCase. Newest token first. */
export const LanGrant = z.object({
  tokens: z.array(LanToken).min(1).max(4),
  peers: z.array(LanPeer).max(64),
});
export type LanGrant = z.infer<typeof LanGrant>;

/** Handshake message 1 (dialer → listener), in the clear: token id, X25519 ephemeral key, random nonce. */
export const LanHello = z.object({
  v: z.literal(1),
  t: z.literal("hello"),
  tid: b64url(16),
  e: b64url(32),
  n: b64url(32),
});
export type LanHello = z.infer<typeof LanHello>;

/** Handshake message 2 (listener → dialer): its ephemeral key and nonce, then its identity, sealed. */
export const LanHelloReply = z.object({
  v: z.literal(1),
  t: z.literal("hello"),
  e: b64url(32),
  n: b64url(32),
  /** LanIdentity, sealed with the listener→dialer key (sequence 0). */
  box: b64url(),
});
export type LanHelloReply = z.infer<typeof LanHelloReply>;

/** Body each side signs (`chalito.lan-handshake.v1`): its role, the transcript hash and both device ids. */
export const LanHandshakeBody = z.object({
  v: z.literal(1),
  role: z.enum(["dialer", "listener"]),
  /** BLAKE2b-256 over the token id, both ephemeral keys and both nonces (lanTranscript). */
  th: b64url(32),
  deviceId: DeviceId,
  peerDeviceId: DeviceId.nullable(),
  issuedAt: EpochMs,
});
export type LanHandshakeBody = z.infer<typeof LanHandshakeBody>;

/** Sealed inside the handshake: who this side is and its signature over the transcript. */
export const LanIdentity = z.object({
  v: z.literal(1),
  deviceId: DeviceId,
  pubSign: PubSign,
  body: LanHandshakeBody,
  sig: Signature,
});
export type LanIdentity = z.infer<typeof LanIdentity>;

/**
 * Frames after the handshake, each sealed with a per-direction key and a strictly increasing
 * sequence number (a replayed, dropped or reordered frame ends the link).
 *
 * - `cmd`: a command signed by a trusted client, for the receiving agent. Only `SignedCommand`:
 *   relayed (unsigned) commands come from the cloud's own services and never ride the LAN.
 * - `ack`: what became of a `cmd` (the receiver's closed reason).
 * - `evt`: an AgentEvent the sender wrote (content sealed to clients as on the cloud path).
 */
export const LanFrame = z.discriminatedUnion("k", [
  z.object({ k: z.literal("cmd"), id: Id, env: SignedCommand }),
  z.object({ k: z.literal("ack"), id: Id, ok: z.boolean(), reason: z.string().max(64).optional() }),
  z.object({ k: z.literal("evt"), e: AgentEvent }),
  z.object({ k: z.literal("bye"), reason: z.string().max(64) }),
]);
export type LanFrame = z.infer<typeof LanFrame>;
