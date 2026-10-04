import { randomBytes, randomNonce, signEnvelope, stepUpChallenge, crockford32 } from "@chalito/crypto";
import {
  APPROVAL_TTL_MS,
  CommandBody,
  CommandPayload,
  DecisionBody,
  DeviceRegistrationBody,
  EndorsementBody,
  RecoveryCode,
  type Decision,
  type DeviceRegistration,
  type Endorsement,
  type SignedCommand,
} from "@chalito/protocol";
import type { DeviceKeys } from "./keys.js";
import { publicKeys } from "./keys.js";

/**
 * Builders for everything a client device signs. Each one validates with the protocol schema
 * BEFORE signing, so a malformed body never gets a signature.
 */

/** A recovery code (protocol `RecoveryCode`): 130 random bits, Crockford base32, 5-5-5-5-6. */
export const generateRecoveryCode = async (): Promise<string> => {
  const chars = crockford32(await randomBytes(17)).slice(0, 26);
  const code = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5)).join("-") + "-" + chars.slice(20);
  return RecoveryCode.parse(code);
};

/** Proof of possession for enrolment: the new device signs its own registration. */
export const signDeviceRegistration = async (
  keys: DeviceKeys,
  r: { owner: string; kind: "phone" | "web"; platform: "ios" | "android" | "web"; name: string; now: number },
): Promise<DeviceRegistration> => {
  const pub = await publicKeys(keys);
  const body = DeviceRegistrationBody.parse({
    v: 1,
    owner: r.owner,
    deviceId: keys.deviceId,
    kind: r.kind,
    platform: r.platform,
    name: r.name,
    pubSign: pub.pubSign,
    pubBox: pub.pubBox,
    issuedAt: r.now,
  });
  return signEnvelope("chalito.device-register.v1", body, keys.deviceId, keys.sign.secretKey);
};

/** A command for one agent, signed by this client (origin `client:<deviceId>`). */
export const signCommand = async (
  keys: DeviceKeys,
  c: { uid: string; targetDeviceId: string; payload: CommandPayload; now: number; ttlMs?: number; cid?: string },
): Promise<SignedCommand> => {
  const body = CommandBody.parse({
    v: 1,
    cid: c.cid ?? (await randomNonce()),
    uid: c.uid,
    targetDeviceId: c.targetDeviceId,
    origin: `client:${keys.deviceId}`,
    nonce: await randomNonce(),
    issuedAt: c.now,
    expiresAt: c.now + (c.ttlMs ?? 60_000),
    payload: CommandPayload.parse(c.payload),
  });
  return signEnvelope("chalito.command.v1", body, keys.deviceId, keys.sign.secretKey);
};

/** Ask an agent to drop a client from its local trusted list. */
export const signRevokeClient = (
  keys: DeviceKeys,
  r: { uid: string; agentDeviceId: string; clientDeviceId: string; now: number },
) =>
  signCommand(keys, {
    uid: r.uid,
    targetDeviceId: r.agentDeviceId,
    payload: { type: "device.revokeClient", clientDeviceId: r.clientDeviceId },
    now: r.now,
  });

/** Produces a WebAuthn assertion over a challenge (see webauthn.ts `assertStepUp`). */
export type StepUpAssertion = (challenge: Uint8Array) => Promise<{
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}>;

/**
 * An approval decision. For HIGH/CRITICAL pass `stepUp`: the passkey assertion is made over
 * SHA-256(JCS(body without stepUp)), so it is bound to this aid, request, agent, nonce and
 * verdict, and the agent verifies it against the passkey it recorded locally (D-019).
 */
export const signDecision = async (
  keys: DeviceKeys,
  d: {
    uid: string;
    aid: string;
    requestId: string;
    targetDeviceId: string;
    allow: boolean;
    now: number;
    choice?: number;
    ttlMs?: number;
    stepUp?: StepUpAssertion;
  },
): Promise<Decision> => {
  const base = DecisionBody.parse({
    v: 1,
    aid: d.aid,
    requestId: d.requestId,
    uid: d.uid,
    targetDeviceId: d.targetDeviceId,
    allow: d.allow,
    nonce: await randomNonce(),
    issuedAt: d.now,
    expiresAt: d.now + Math.min(d.ttlMs ?? APPROVAL_TTL_MS, APPROVAL_TTL_MS),
    ...(d.choice !== undefined ? { choice: d.choice } : {}),
  });
  const body = d.stepUp
    ? DecisionBody.parse({
        ...base,
        stepUp: { method: "webauthn", at: d.now, assertion: await d.stepUp(await stepUpChallenge(base)) },
      })
    : base;
  return signEnvelope("chalito.decision.v1", body, keys.deviceId, keys.sign.secretKey);
};

/** Vouches for a new browser/phone of the same account (agents verify it against their own list). */
export const signEndorsement = async (
  keys: DeviceKeys,
  e: { uid: string; newDeviceId: string; pubSign: string; pubBox: string; now: number },
): Promise<Endorsement> => {
  const body = EndorsementBody.parse({
    v: 1,
    uid: e.uid,
    newDeviceId: e.newDeviceId,
    pubSign: e.pubSign,
    pubBox: e.pubBox,
    issuedAt: e.now,
  });
  return signEnvelope("chalito.endorsement.v1", body, keys.deviceId, keys.sign.secretKey);
};
