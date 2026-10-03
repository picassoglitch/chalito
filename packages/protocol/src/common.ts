import { z } from "zod";

/**
 * Shared primitives for every Chalito wire schema.
 *
 * Conventions (see docs/adr/0003-e2e-design.md):
 * - Every top-level wire object carries `v` (the schema version of that object).
 * - Timestamps on the wire are integer epoch milliseconds (UTC). Firestore
 *   converts them to `Timestamp` at the storage edge (TTL fields must be Timestamps).
 * - Binary values (keys, nonces, ciphertext, signatures) are unpadded base64url.
 * - Plaintext fields are metadata only. Content (prompts, replies, diffs, paths,
 *   commands, room messages) always travels inside a sealed envelope.
 */

export const PROTOCOL_VERSION = 1 as const;

export const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url string, optionally constrained to an exact decoded byte length. */
export const b64url = (bytes?: number) => {
  const base = z.string().regex(B64URL_RE, "must be unpadded base64url");
  if (bytes === undefined) return base;
  const len = Math.ceil((bytes * 4) / 3);
  return base.length(len, `must encode exactly ${bytes} bytes`);
};

export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

/** Ed25519 public key (32 bytes). */
export const PubSign = b64url(32);
/** X25519 public key (32 bytes). */
export const PubBox = b64url(32);
/** Ed25519 detached signature (64 bytes). */
export const Signature = b64url(64);
/** Random nonce for replay protection (16 bytes). */
export const ReplayNonce = b64url(16);

/**
 * Human-comparable key fingerprint: first 10 bytes of BLAKE2b-256(pubSign),
 * rendered as 4 groups of 4 Crockford base32 characters (e.g. "7K2Q-M9XD-4TPA-W3HC").
 */
export const Fingerprint = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

/** Opaque document ids (Firestore-safe). */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "id must be [A-Za-z0-9_-]");

export const Uid = Id;
export const DeviceId = Id;
export const SessionId = Id;
export const ApprovalId = Id;
export const RoomId = Id;
export const MesaId = Id;
export const NotificationId = Id;

/** Companion identifier: `chl_` + 128 random bits in lowercase RFC 4648 base32 (26 chars, no padding). */
export const CompanionId = z.string().regex(/^chl_[a-z2-7]{26}$/, "companionId must be chl_ + 26 base32 chars");
export type CompanionId = z.infer<typeof CompanionId>;

export const Locale = z.enum(["es", "en"]);
export type Locale = z.infer<typeof Locale>;

export const Urgency = z.enum(["low", "normal", "high", "critical"]);
export type Urgency = z.infer<typeof Urgency>;

export const RiskTier = z.enum(["LOW", "MED", "HIGH", "CRITICAL"]);
export type RiskTier = z.infer<typeof RiskTier>;

/** Escalation level L0 (ambient) … L4 (interrupt / call). */
export const Level = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export type Level = z.infer<typeof Level>;

export const Platform = z.enum(["linux", "windows", "macos", "ios", "android", "web"]);
export const DeviceKind = z.enum(["desktop", "laptop", "phone", "web"]);

export const AdapterKind = z.enum(["claude-code", "codex", "acp"]);
export type AdapterKind = z.infer<typeof AdapterKind>;

/**
 * Where a session prompt came from. The agent's local policy can disable each origin.
 * Only `local` and `client:<id>` are signed by a trusted key; `mcp:*` and `call:*` are
 * relayed by the cloud and are therefore never eligible for Developer-mode auto-approve.
 */
export const Origin = z.union([
  z.literal("local"),
  z.string().regex(/^client:[A-Za-z0-9_-]{1,128}$/),
  z.string().regex(/^mcp:(chatgpt|claude)$/),
  z.string().regex(/^call:CA[0-9a-f]{32}$/),
]);
// There is deliberately no `room:*` origin: room content can never start or steer a session.
// A human acting on a room notice does so from their own app, which is a `client:<id>` origin.
export type Origin = z.infer<typeof Origin>;

export const isSignedOrigin = (o: Origin): boolean => o === "local" || o.startsWith("client:");

/**
 * Permission modes a remote surface (client, cloud, MCP) may request.
 * `bypassPermissions` is intentionally absent: it can never be set remotely.
 * The device policy (~/.chalito/policy.yaml) remains the ceiling.
 */
export const RemotePermissionMode = z.enum(["default", "plan", "acceptEdits"]);
export type RemotePermissionMode = z.infer<typeof RemotePermissionMode>;

/** Codex sandbox modes a remote surface may request. `danger-full-access` is intentionally absent. */
export const RemoteCodexSandbox = z.enum(["read-only", "workspace-write"]);
export type RemoteCodexSandbox = z.infer<typeof RemoteCodexSandbox>;

/** Emotion tags carried by every companion reply; drive expressions + gestures. */
export const EmotionTag = z.enum([
  "neutral",
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
  "excited",
  "tired",
  "thinking",
  "worried",
]);
export type EmotionTag = z.infer<typeof EmotionTag>;

export const Emotion = z.object({
  tag: EmotionTag,
  intensity: z.number().min(0).max(1),
});
export type Emotion = z.infer<typeof Emotion>;

/** Relative in-app deep link (never an absolute URL; never carries content). */
export const DeepLink = z
  .string()
  .regex(/^\/(en\/)?(a|m|r|s)\/[A-Za-z0-9_-]{1,128}$|^\/(en\/)?creditos$|^\/(en\/)?$/, "invalid deep link");

/** Counters only; used wherever a channel must not carry content. */
export const Counts = z.object({
  approvals: z.number().int().nonnegative().default(0),
  questions: z.number().int().nonnegative().default(0),
  messages: z.number().int().nonnegative().default(0),
  mesas: z.number().int().nonnegative().default(0),
});
export type Counts = z.infer<typeof Counts>;

/** Billing units metered for managed usage. */
export const Units = z.object({
  tokens: z.number().int().default(0),
  voiceMin: z.number().default(0),
  calls: z.number().int().default(0),
  whatsapp: z.number().int().default(0),
});
export type Units = z.infer<typeof Units>;

export const EfficiencyProfile = z.enum(["max", "standard", "low", "free_min"]);
export type EfficiencyProfile = z.infer<typeof EfficiencyProfile>;
