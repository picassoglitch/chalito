import { describe, expect, it } from "vitest";
import {
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
  verifyWebAuthnBinding,
} from "../src/index.js";

const RP = "chalito.chalyb.com";

const device = async () => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    sign,
    deviceId: await deriveDeviceId(sign.publicKey),
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
  };
};

const binding = async (subject: { deviceId: string }, signer: Awaited<ReturnType<typeof device>>, rpId = RP) =>
  signEnvelope(
    "chalito.webauthn-binding.v1",
    {
      v: 1 as const,
      deviceId: subject.deviceId,
      credentialId: "Y3JlZC0x",
      publicKey: "cHViLWtleQ",
      rpId,
      issuedAt: Date.now(),
    },
    signer.deviceId,
    signer.sign.secretKey,
  );

describe("WebAuthn binding (passkey ↔ device key)", () => {
  it("verifies against the confirmed device key and records the passkey", async () => {
    const phone = await device();
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
    const res = await list.attachWebAuthnBinding(await binding(phone, phone), RP);
    expect(res).toEqual({ ok: true, credential: { credentialId: "Y3JlZC0x", publicKey: "cHViLWtleQ", rpId: RP } });
    expect(list.webauthnFor(phone.deviceId)).toEqual({ credentialId: "Y3JlZC0x", publicKey: "cHViLWtleQ", rpId: RP });
    // Persisted with the list.
    expect(list.toJSON()[0]!.webauthn?.credentialId).toBe("Y3JlZC0x");
  });

  it("a binding signed by another key is refused (and nothing is recorded)", async () => {
    const phone = await device();
    const attacker = await device();
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
    // Claims to be the phone's binding but signed by the attacker (signerDeviceId forged to the phone's).
    const forged = { ...(await binding(phone, attacker)), signerDeviceId: phone.deviceId };
    expect(await list.attachWebAuthnBinding(forged)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(list.webauthnFor(phone.deviceId)).toBeUndefined();
    // Honestly signed by the attacker for the phone: wrong device.
    expect(await list.attachWebAuthnBinding(await binding(phone, attacker))).toEqual({
      ok: false,
      reason: "wrong_device",
    });
  });

  it("rejects another relying party, an untrusted client and a tampered body", async () => {
    const phone = await device();
    const list = new TrustedClientList("dev_agent");
    expect(await list.attachWebAuthnBinding(await binding(phone, phone))).toEqual({
      ok: false,
      reason: "untrusted_client",
    });
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
    expect(await list.attachWebAuthnBinding(await binding(phone, phone, "evil.example"), RP)).toEqual({
      ok: false,
      reason: "expected_rp_mismatch",
    });
    const b = await binding(phone, phone);
    const tampered = { ...b, body: { ...b.body, publicKey: "b3RoZXI" } };
    expect(await verifyWebAuthnBinding(tampered, { deviceId: phone.deviceId, pubSign: phone.pubSign })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("endorsed clients: the new client's own binding comes along; one signed by the endorser is refused", async () => {
    const phone = await device();
    const browser = await device();
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
    const endorsement = await signEnvelope(
      "chalito.endorsement.v1",
      {
        v: 1 as const,
        uid: "u1",
        newDeviceId: browser.deviceId,
        pubSign: browser.pubSign,
        pubBox: browser.pubBox,
        issuedAt: Date.now(),
      },
      phone.deviceId,
      phone.sign.secretKey,
    );
    const byEndorser = await binding(browser, phone);
    expect(await list.addEndorsed(endorsement, Date.now(), undefined, byEndorser)).toBe(false);
    expect(list.has(browser.deviceId)).toBe(false);

    expect(await list.addEndorsed(endorsement, Date.now(), undefined, await binding(browser, browser))).toBe(true);
    expect(list.webauthnFor(browser.deviceId)?.credentialId).toBe("Y3JlZC0x");
  });
});
