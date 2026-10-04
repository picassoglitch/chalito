import { randomUUID } from "node:crypto";
import {
  deriveDeviceId,
  fingerprint,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { hashShortCode, signGlyph } from "@chalito/glyph";
import {
  DeviceRegistrationBody,
  EndorsementBody,
  type DeviceDoc,
  type Endorsement,
  type PairingCodeDoc,
} from "@chalito/protocol";
import type { NewEndorseCode, StoredRecovery } from "../../src/repo.js";

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
    claimerWebauthnBinding: null,
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

/** A new client's self-signed registration and the code it opens (repo-level: nothing verified). */
export const endorseCode = async (ownerId: string, now = Date.now()) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  const deviceId = await deriveDeviceId(sign.publicKey);
  const registration = await signEnvelope(
    "chalito.device-register.v1",
    DeviceRegistrationBody.parse({
      v: 1,
      owner: ownerId,
      deviceId,
      kind: "web",
      platform: "web",
      name: "Chalito (desktop)",
      pubSign: await toB64url(sign.publicKey),
      pubBox: await toB64url(box.publicKey),
      issuedAt: now,
    }),
    deviceId,
    sign.secretKey,
  );
  const code: NewEndorseCode = {
    codeId: randomUUID().replace(/-/g, "").slice(0, 22),
    shortCodeHash: await hashShortCode(`E${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`),
    owner: ownerId,
    registration,
    expiresAt: now + 5 * 60_000,
  };
  return code;
};

/** An endorsement-shaped envelope for repo tests (signature unchecked at this layer). */
export const endorsementFor = async (code: NewEndorseCode, signerDeviceId: string): Promise<Endorsement> => {
  const signer = await generateSigningKeyPair();
  return signEnvelope(
    "chalito.endorsement.v1",
    EndorsementBody.parse({
      v: 1,
      uid: code.owner,
      newDeviceId: code.registration.body.deviceId,
      pubSign: code.registration.body.pubSign,
      pubBox: code.registration.body.pubBox,
      issuedAt: Date.now(),
    }),
    signerDeviceId,
    signer.secretKey,
  );
};
