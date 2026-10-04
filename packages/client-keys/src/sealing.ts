import { deriveDeviceId, fromB64url, sealJson } from "@chalito/crypto";
import type { GlyphPayload, SealedEnvelope } from "@chalito/protocol";

/** The agent this browser paired with, from the glyph whose fingerprint the user confirmed. */
export const agentFromGlyph = async (glyph: GlyphPayload) => {
  if (!glyph.body.issuerPubBox) throw new Error("glyph has no box key");
  return {
    deviceId: await deriveDeviceId(await fromB64url(glyph.body.issuerPubSign)),
    pubBox: glyph.body.issuerPubBox,
  };
};

/**
 * Seals content (prompts, answers) to a set of devices, base64url X25519 keys by device id.
 * `aad` binds the ciphertext to its document (e.g. `command:<cid>`) so it can't be moved.
 */
export const sealFor = async (
  value: unknown,
  recipients: Readonly<Record<string, string>>,
  aad: string,
): Promise<SealedEnvelope> => {
  const keys: Record<string, Uint8Array> = {};
  for (const [id, pub] of Object.entries(recipients)) keys[id] = await fromB64url(pub);
  return sealJson(value, keys, aad);
};
