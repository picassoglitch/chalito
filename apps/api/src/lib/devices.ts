import { deriveDeviceId, fingerprint, fromB64url, verifyEnvelope } from "@chalito/crypto";
import type { DeviceDoc, DeviceRegistration } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { fail } from "./errors.js";

/** Checks a self-signed registration: id derived from the key, signature by that key, fresh. */
export const checkRegistration = async (
  deps: Deps,
  reg: DeviceRegistration,
  owner: string,
  allowedKinds: DeviceDoc["kind"][],
): Promise<void> => {
  const b = reg.body;
  if (b.owner !== owner) fail(403, "owner_mismatch");
  if (!allowedKinds.includes(b.kind)) fail(400, "kind_not_allowed");
  if (reg.signerDeviceId !== b.deviceId) fail(400, "signer_mismatch");
  if (Math.abs(deps.now() - b.issuedAt) > deps.config.skewMs * 5) fail(400, "stale_request");
  const pub = await fromB64url(b.pubSign);
  if ((await deriveDeviceId(pub)) !== b.deviceId) fail(400, "device_id_mismatch");
  const ok = await verifyEnvelope(reg, "chalito.device-register.v1", new Map([[b.deviceId, pub]]));
  if (!ok.ok) fail(400, "bad_signature");
};

export const buildDeviceDoc = async (
  deps: Deps,
  input: {
    owner: string;
    deviceId: string;
    kind: DeviceDoc["kind"];
    platform: DeviceDoc["platform"];
    name: string;
    role: DeviceDoc["role"];
    pubSign: string;
    pubBox: string;
    enrolledVia: DeviceDoc["enrolledVia"];
    endorsedBy: string | null;
  },
): Promise<DeviceDoc> => ({
  v: 1,
  ...input,
  fingerprint: await fingerprint(await fromB64url(input.pubSign)),
  revoked: false,
  revokedAt: null,
  createdAt: deps.now(),
  lastSeenAt: null,
  policyHash: null,
  devMode: { on: false, toggles: [], since: null },
});

/** Credential for a device identity. */
export const mintDeviceToken = (deps: Deps, owner: string, deviceId: string, role: "client" | "agent") =>
  deps.identity.mintDevice(owner, deviceId, role);
