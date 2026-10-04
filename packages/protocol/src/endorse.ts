import { z } from "zod";
import { EpochMs } from "./common.js";
import { Endorsement } from "./crypto.js";
import { DeviceRegistration } from "./api.js";
import { ShortCode } from "./glyph.js";

/**
 * Endorsement handoff (/v1/endorse, ADR 0006): how a new client device of the same account
 * gets an endorsement from a trusted client. The new device publishes its self-signed
 * registration and shows an `endorse_client` glyph (or the short code); the trusted client
 * resolves it, checks the fingerprint and posts a signed endorsement; the new device hears a
 * pointer on `chalito:pairing:<codeId>` and takes it, then enrols with /v1/devices/endorsed.
 */

/** Same shape as a glyph's codeId (the new device signs its glyph over it). */
export const EndorseCodeId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** New device (person session, `user`). */
export const CreateEndorseCodeRequest = z.object({ registration: DeviceRegistration });
export const CreateEndorseCodeResponse = z.object({
  codeId: EndorseCodeId,
  shortCode: ShortCode,
  /** Scoped credential (magic-link hash) that can only listen on `chalito:pairing:<codeId>`. */
  watchToken: z.string().min(1),
  expiresAt: EpochMs,
});

/** Trusted client (`client`): by the scanned glyph's codeId, or by the typed short code. */
export const ResolveEndorseCodeRequest = z.union([
  z.object({ codeId: EndorseCodeId }).strict(),
  z.object({ shortCode: z.string().min(8).max(20) }).strict(),
]);
export const ResolveEndorseCodeResponse = z.object({
  codeId: EndorseCodeId,
  registration: DeviceRegistration,
  expiresAt: EpochMs,
});

/**
 * Trusted client (`client`). `stepUp` is a WebAuthn assertion over a server challenge
 * (/v1/webauthn/assert/options): required when the endorsing device has a passkey.
 */
export const ApproveEndorseCodeRequest = z.object({
  codeId: EndorseCodeId,
  endorsement: Endorsement,
  stepUp: z.record(z.string(), z.unknown()).optional(),
});

/** New device (`user`): single use. */
export const TakeEndorsementRequest = z.object({ codeId: EndorseCodeId });
export const TakeEndorsementResponse = z.object({ endorsement: Endorsement });
