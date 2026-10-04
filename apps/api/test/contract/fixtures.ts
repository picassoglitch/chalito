import { randomUUID } from "node:crypto";
import {
  deriveDeviceId,
  fingerprint,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  toB64url,
} from "@chalito/crypto";
import { hashShortCode, signGlyph } from "@chalito/glyph";
import type { DeviceDoc, PairingCodeDoc } from "@chalito/protocol";
import type { StoredRecovery } from "../../src/repo.js";

/** Real keys and derived ids, so a schema with format constraints accepts the fixtures. */
export const owner = () => `contract-${randomUUID()}`;

export const device = async (
  ownerId: string,
  role: DeviceDoc["role"] = "client",
  overrides: Partial<DeviceDoc> = {},
): Promise<DeviceDoc> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    v: 1,
    deviceId: await deriveDeviceId(sign.publicKey),
    owner: ownerId,
    kind: role === "agent" ? "laptop" : "phone",
    platform: role === "agent" ? "linux" : "android",
    name: role === "agent" ? "Laptop" : "Teléfono",
    role,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
    fingerprint: await fingerprint(sign.publicKey),
    enrolledVia: role === "agent" ? "pairing" : "first_client",
    endorsedBy: null,
    revoked: false,
    revokedAt: null,
    createdAt: 1_790_000_000_000,
    lastSeenAt: null,
    policyHash: null,
    devMode: { on: false, toggles: [], since: null },
    ...overrides,
  };
};

export const recovery = (n = 1): StoredRecovery => ({
  alg: "scrypt",
  salt: `salt-${n}`,
  hash: `hash-${n}`,
  N: 32768,
  r: 8,
  p: 1,
  cooldownUntil: null,
  createdAt: 1_790_000_000_000 + n,
});

/** A pairing code published by a fresh agent key; `agent` is the device doc a claim would create. */
export const pairingCode = async (now = Date.now()) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  const shortCode = `C${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`;
  const glyph = await signGlyph(
    {
      v: 1,
      purpose: "pair_device",
      codeId: `code_${randomUUID().replace(/-/g, "")}`,
      issuerPubSign: await toB64url(sign.publicKey),
      issuerPubBox: await toB64url(box.publicKey),
      label: "Laptop",
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
      nonce: await randomNonce(),
    },
    sign.secretKey,
  );
  const doc: PairingCodeDoc = {
    v: 1,
    codeId: glyph.body.codeId,
    shortCodeHash: await hashShortCode(shortCode),
    glyph,
    agentDeviceId: await deriveDeviceId(sign.publicKey),
    kind: "laptop",
    platform: "linux",
    claimed: false,
    owner: null,
    claimedByDeviceId: null,
    claimerPubSign: null,
    claimerPubBox: null,
    expiresAt: glyph.body.expiresAt,
  };
  return doc;
};

export const agentFor = async (code: PairingCodeDoc, ownerId: string, claimer: string): Promise<DeviceDoc> => ({
  ...(await device(ownerId, "agent")),
  deviceId: code.agentDeviceId,
  pubSign: code.glyph.body.issuerPubSign,
  pubBox: code.glyph.body.issuerPubBox ?? "",
  fingerprint: await fingerprint(await fromB64url(code.glyph.body.issuerPubSign)),
  endorsedBy: claimer,
});

export const RACERS = 10;
export const count = <T>(xs: T[], x: T) => xs.filter((y) => y === x).length;
