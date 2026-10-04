import { randomNonce } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import type { GlyphPayload } from "@chalito/protocol";

/**
 * A room invite as a Chalito Glyph (ADR 0007/0010), signed by the inviting member's device. The
 * api keeps only hashes of it and of the short code it returns.
 */
export const buildInviteGlyph = async (i: {
  inviteId: string;
  roomName: string;
  pubSign: string;
  pubBox: string;
  secretKey: Uint8Array;
  now: number;
  ttlMs: number;
}): Promise<GlyphPayload> =>
  signGlyph(
    {
      v: 1,
      purpose: "room_invite",
      codeId: i.inviteId,
      issuerPubSign: i.pubSign,
      issuerPubBox: i.pubBox,
      label: i.roomName.slice(0, 40),
      issuedAt: i.now,
      expiresAt: i.now + i.ttlMs,
      nonce: (await randomNonce()).slice(0, 22),
    },
    i.secretKey,
  );
