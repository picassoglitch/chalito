import {
  deriveDeviceId,
  fingerprint,
  fromB64url,
  randomNonce,
  stepUpChallenge,
  toB64url,
  verifyEnvelope,
} from "@chalito/crypto";
import { signGlyph, verifyGlyph } from "@chalito/glyph";
import {
  EndorsementBody,
  GlyphPayload,
  ResolveEndorseCodeResponse,
  type DeviceRegistration,
  type Endorsement,
  type IntroducedAgent,
} from "@chalito/protocol";
import { ApiError, type ApiClient } from "./api.js";
import type { DeviceKeys, TrustedAgent } from "./keys.js";
import type { StepUpAssertion } from "./signing.js";
import type { DeviceSigner } from "./webauthn.js";

/**
 * The endorsement handoff's key flows (/v1/endorse, ADR 0006). The new device's waiting side
 * (publish, watch, take) is @chalito/client's `endorsementChannel`.
 *
 *  - New device: `endorseGlyph` signs the `endorse_client` glyph over the server's code with
 *    the key it registers, so a scan binds the code to that key.
 *  - Trusted client: `resolveForEndorsement` (scanned glyph or typed short code) checks the
 *    registration and returns what the person must compare; `approveEndorsement` signs the
 *    endorsement for exactly those keys and posts it, with a passkey step-up if this device
 *    has one.
 */

export class EndorseError extends Error {
  override name = "EndorseError";
  constructor(readonly code: string) {
    super(`endorse: ${code}`);
  }
}

/** New device: the glyph shown next to the short code. */
export const endorseGlyph = async (
  keys: DeviceKeys,
  code: { codeId: string; expiresAt: number },
  o: { label: string; now: number },
): Promise<GlyphPayload> =>
  signGlyph(
    {
      v: 1,
      purpose: "endorse_client",
      codeId: code.codeId,
      issuerPubSign: await toB64url(keys.sign.publicKey),
      issuerPubBox: await toB64url(keys.box.publicKey),
      label: o.label.slice(0, 40),
      issuedAt: o.now,
      expiresAt: code.expiresAt,
      nonce: await randomNonce(),
    },
    keys.sign.secretKey,
  );

export interface EndorseTarget {
  codeId: string;
  registration: DeviceRegistration;
  expiresAt: number;
  /** What the person checks on both screens before approving. */
  display: { name: string; kind: string; deviceId: string; fingerprint: string; expiresInMs: number };
}

/**
 * Trusted client: from a scanned glyph (verified: signature, purpose, time) or a typed short
 * code, fetch the new device's registration and check it is self-consistent and, for a glyph,
 * registered with the very key that signed the glyph.
 */
export const resolveForEndorsement = async (
  api: ApiClient,
  input: { glyph: unknown } | { shortCode: string },
  now: number,
): Promise<EndorseTarget> => {
  let codeId: string | null = null;
  let glyphKey: string | null = null;
  if ("glyph" in input) {
    const g = GlyphPayload.safeParse(input.glyph);
    if (!g.success) throw new EndorseError("malformed");
    if (g.data.body.purpose !== "endorse_client") throw new EndorseError("wrong_purpose");
    const check = await verifyGlyph(g.data, now);
    if (!check.ok) throw new EndorseError(check.reason);
    codeId = g.data.body.codeId;
    glyphKey = g.data.body.issuerPubSign;
  }
  let res;
  try {
    res = ResolveEndorseCodeResponse.parse(
      await api.post(
        "/v1/endorse/resolve",
        codeId ? { codeId } : { shortCode: (input as { shortCode: string }).shortCode },
      ),
    );
  } catch (err) {
    throw new EndorseError(err instanceof ApiError ? err.code : "bad_response");
  }
  if (codeId && res.codeId !== codeId) throw new EndorseError("code_mismatch");
  const reg = res.registration;
  if (glyphKey && reg.body.pubSign !== glyphKey) throw new EndorseError("key_mismatch");
  const pub = await fromB64url(reg.body.pubSign);
  if (reg.signerDeviceId !== reg.body.deviceId || (await deriveDeviceId(pub)) !== reg.body.deviceId)
    throw new EndorseError("device_id_mismatch");
  const sig = await verifyEnvelope(reg, "chalito.device-register.v1", new Map([[reg.body.deviceId, pub]]));
  if (!sig.ok) throw new EndorseError("bad_registration");
  return {
    codeId: res.codeId,
    registration: reg,
    expiresAt: res.expiresAt,
    display: {
      name: reg.body.name,
      kind: reg.body.kind,
      deviceId: reg.body.deviceId,
      fingerprint: await fingerprint(pub),
      expiresInMs: Math.max(0, res.expiresAt - now),
    },
  };
};

/**
 * Trusted client, after the person compared the fingerprint: sign the endorsement for exactly
 * the resolved keys (with this device's passkey assertion over it, when it has a passkey) and
 * post it.
 */
export const approveEndorsement = async (
  api: ApiClient,
  signer: DeviceSigner,
  target: Pick<EndorseTarget, "codeId" | "registration">,
  o: {
    uid: string;
    now: number;
    /**
     * This device's passkey (e.g. `stepUpWithPasskey(ref)`), REQUIRED when it has one: the
     * assertion is made over SHA-256(JCS(endorsement body without stepUp)) and goes into the
     * body, so the api and every agent verify the same proof (R-L13, ADR 0018).
     */
    stepUp?: StepUpAssertion;
    /**
     * ADR 0018: this client's trusted agents, introduced to the new client (and the only
     * agents that will accept it). Only glyph-confirmed ones are passed on: no trust chains.
     */
    agents?: readonly TrustedAgent[];
  },
): Promise<void> => {
  const reg = target.registration.body;
  if (reg.owner !== o.uid) throw new EndorseError("owner_mismatch");
  if (reg.deviceId === signer.deviceId) throw new EndorseError("self_endorsement");
  const base = EndorsementBody.parse({
    v: 1,
    uid: o.uid,
    newDeviceId: reg.deviceId,
    pubSign: reg.pubSign,
    pubBox: reg.pubBox,
    issuedAt: o.now,
    ...(o.agents
      ? {
          agents: o.agents
            .filter((a) => a.via !== "endorsement")
            .slice(0, 32)
            .map((a) => ({ deviceId: a.deviceId, pubSign: a.pubSign, pubBox: a.pubBox, fingerprint: a.fingerprint })),
        }
      : {}),
  });
  // A cancelled passkey prompt rejects here, before anything is signed or sent.
  const body = o.stepUp
    ? EndorsementBody.parse({
        ...base,
        stepUp: { method: "webauthn", at: o.now, assertion: await o.stepUp(await stepUpChallenge(base)) },
      })
    : base;
  const endorsement = await signer.sign("chalito.endorsement.v1", body);
  try {
    await api.post("/v1/endorse/approve", { codeId: target.codeId, endorsement });
  } catch (err) {
    throw new EndorseError(err instanceof ApiError ? err.code : "failed");
  }
};

/** A row of the account's devices directory (`chalito.devices`, read under RLS). Cloud data. */
export interface DirectoryDevice {
  deviceId: string;
  role: "agent" | "client";
  revoked: boolean;
  pubSign: string;
  pubBox: string;
}

export type DroppedAgent = {
  deviceId: string;
  reason: "not_in_directory" | "not_an_agent" | "revoked" | "key_mismatch" | "fingerprint_mismatch";
};

export type IntroductionCheck =
  | { ok: true; agents: IntroducedAgent[]; dropped: DroppedAgent[] }
  | { ok: false; reason: "endorser_unknown" | "bad_signature" | "not_for_this_device" };

/**
 * ADR 0018, the new client's side: which introduced agents to trust. The endorsement must verify
 * against the endorser's key in the directory and be for exactly this device's keys; then each
 * listed agent must match its directory row (active agent, same keys) and its fingerprint and
 * id must derive from its key. Two independent sources must agree, so a server-side key swap
 * for an agent (or a tampered list) gets nothing trusted.
 */
export const introducedAgents = async (
  e: Endorsement,
  self: { uid: string; deviceId: string; pubSign: string; pubBox: string },
  directory: readonly DirectoryDevice[],
): Promise<IntroductionCheck> => {
  const endorser = directory.find((d) => d.deviceId === e.signerDeviceId);
  if (!endorser || endorser.revoked || endorser.role !== "client") return { ok: false, reason: "endorser_unknown" };
  const sig = await verifyEnvelope(
    e,
    "chalito.endorsement.v1",
    new Map([[endorser.deviceId, await fromB64url(endorser.pubSign)]]),
  );
  if (!sig.ok) return { ok: false, reason: "bad_signature" };
  const b = e.body;
  if (b.uid !== self.uid || b.newDeviceId !== self.deviceId || b.pubSign !== self.pubSign || b.pubBox !== self.pubBox)
    return { ok: false, reason: "not_for_this_device" };
  const agents: IntroducedAgent[] = [];
  const dropped: DroppedAgent[] = [];
  for (const a of b.agents ?? []) {
    const row = directory.find((d) => d.deviceId === a.deviceId);
    let reason: DroppedAgent["reason"] | null = null;
    if (!row) reason = "not_in_directory";
    else if (row.role !== "agent") reason = "not_an_agent";
    else if (row.revoked) reason = "revoked";
    else if (row.pubSign !== a.pubSign || row.pubBox !== a.pubBox) reason = "key_mismatch";
    else {
      const pub = await fromB64url(a.pubSign);
      if ((await fingerprint(pub)) !== a.fingerprint || (await deriveDeviceId(pub)) !== a.deviceId)
        reason = "fingerprint_mismatch";
    }
    if (reason) dropped.push({ deviceId: a.deviceId, reason });
    else agents.push(a);
  }
  return { ok: true, agents, dropped };
};
