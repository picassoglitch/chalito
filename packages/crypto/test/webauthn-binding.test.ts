import { describe, expect, it } from "vitest";
import {
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
  verifyWebAuthnBinding,
  stepUpChallenge,
} from "../src/index.js";
import { authenticator } from "./soft-authenticator.js";

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

  /** The endorser (phone) with a passkey THIS agent recorded at the reverse check. */
  const endorserWithPasskey = async () => {
    const phone = await device();
    const auth = authenticator(-8);
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed(
      {
        deviceId: phone.deviceId,
        pubSign: phone.pubSign,
        pubBox: phone.pubBox,
        webauthn: { ...auth.credential, rpId: RP },
      },
      Date.now(),
    );
    return { phone, auth, list };
  };
  const endorsementBody = (b: Awaited<ReturnType<typeof device>>) => ({
    v: 1 as const,
    uid: "u1",
    newDeviceId: b.deviceId,
    pubSign: b.pubSign,
    pubBox: b.pubBox,
    issuedAt: Date.now(),
  });
  /** Signed by `signer`, with the endorser's assertion over the body when `auth` is given. */
  const endorse = async (
    signer: Awaited<ReturnType<typeof device>>,
    body: ReturnType<typeof endorsementBody>,
    auth?: ReturnType<typeof authenticator>,
  ) => {
    const withStepUp = auth
      ? {
          ...body,
          stepUp: {
            method: "webauthn" as const,
            at: Date.now(),
            assertion: auth.get({ challenge: await stepUpChallenge(body), rpId: RP, origin: `https://${RP}` }),
          },
        }
      : body;
    return signEnvelope("chalito.endorsement.v1", withStepUp, signer.deviceId, signer.sign.secretKey);
  };

  it("R-L13: an endorser with a passkey must step up; a stolen, unlocked phone can't vouch alone", async () => {
    const { phone, auth, list } = await endorserWithPasskey();
    const attacker = await device();
    // The thief has the phone's device key but not its passkey (no user verification).
    const noStepUp = await endorse(phone, endorsementBody(attacker));
    expect(
      await list.addEndorsed(noStepUp, Date.now(), { webauthnBinding: await binding(attacker, attacker) }),
    ).toEqual({
      ok: false,
      reason: "missing_step_up",
    });
    // An assertion by some other authenticator, or over another body, doesn't count.
    const forged = await endorse(phone, endorsementBody(attacker), authenticator(-8));
    expect((await list.addEndorsed(forged, Date.now())).ok).toBe(false);
    const reused = await endorse(phone, endorsementBody(attacker), auth);
    const swapped = { ...reused, body: { ...reused.body, pubBox: (await device()).pubBox } };
    expect((await list.addEndorsed(swapped as never, Date.now())).ok).toBe(false);
    expect(list.has(attacker.deviceId)).toBe(false);
  });

  it("with the endorser's step-up, the new client's own binding comes along; one signed by the endorser is refused", async () => {
    const { phone, auth, list } = await endorserWithPasskey();
    const browser = await device();
    const e = await endorse(phone, endorsementBody(browser), auth);
    expect(await list.addEndorsed(e, Date.now(), { webauthnBinding: await binding(browser, phone) })).toEqual({
      ok: false,
      reason: "bad_binding",
    });
    expect(list.has(browser.deviceId)).toBe(false);
    expect(await list.addEndorsed(e, Date.now(), { webauthnBinding: await binding(browser, browser) })).toEqual({
      ok: true,
      passkey: true,
    });
    expect(list.webauthnFor(browser.deviceId)?.credentialId).toBe("Y3JlZC0x");
  });

  it("an endorser without a passkey here: the client is trusted but its passkey is never recorded (no HIGH)", async () => {
    const phone = await device();
    const browser = await device();
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
    const e = await endorse(phone, endorsementBody(browser));
    expect(await list.addEndorsed(e, Date.now(), { webauthnBinding: await binding(browser, browser) })).toEqual({
      ok: true,
      passkey: false,
    });
    expect(list.has(browser.deviceId)).toBe(true);
    expect(list.webauthnFor(browser.deviceId)).toBeUndefined();
  });
});
