import { describe, expect, it } from "vitest";
import {
  MemoryNonceStore,
  TrustedClientList,
  fromB64url,
  openJson,
  verifyEnvelope,
  verifyWebAuthnAssertion,
  stepUpChallenge,
} from "@chalito/crypto";
import { Decision, DeviceRegistration, Endorsement, RecoveryCode, SignedCommand } from "@chalito/protocol";
import {
  generateDeviceKeys,
  generateRecoveryCode,
  publicKeys,
  sealFor,
  signCommand,
  signDecision,
  signDeviceRegistration,
  signEndorsement,
  stepUpWithPasskey,
} from "../src/index.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const NOW = 1_790_000_000_000;
const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;

describe("recovery codes", () => {
  it("match the protocol format and don't repeat", async () => {
    const codes = await Promise.all(Array.from({ length: 50 }, () => generateRecoveryCode()));
    for (const c of codes) expect(RecoveryCode.safeParse(c).success).toBe(true);
    expect(new Set(codes).size).toBe(50);
  });
});

describe("signed builders", () => {
  it("a device registration is a self-signed proof of possession", async () => {
    const k = await generateDeviceKeys();
    const reg = await signDeviceRegistration(k, {
      owner: "u1",
      kind: "web",
      platform: "web",
      name: "Chrome",
      now: NOW,
    });
    expect(DeviceRegistration.safeParse(reg).success).toBe(true);
    const ok = await verifyEnvelope(reg, "chalito.device-register.v1", new Map([[k.deviceId, k.sign.publicKey]]));
    expect(ok.ok).toBe(true);
  });

  it("a command is signed for one agent with origin client:<id>", async () => {
    const k = await generateDeviceKeys();
    const cmd = await signCommand(k, {
      uid: "u1",
      targetDeviceId: "dev_agent",
      payload: { type: "devmode.off" },
      now: NOW,
    });
    expect(SignedCommand.safeParse(cmd).success).toBe(true);
    expect(cmd.body.origin).toBe(`client:${k.deviceId}`);
    expect((await verifyEnvelope(cmd, "chalito.command.v1", new Map([[k.deviceId, k.sign.publicKey]]))).ok).toBe(true);
  });

  it("refuses to sign a malformed command", async () => {
    const k = await generateDeviceKeys();
    await expect(
      signCommand(k, { uid: "u1", targetDeviceId: "dev_agent", payload: { type: "devmode.on" } as never, now: NOW }),
    ).rejects.toThrow();
  });

  it("an endorsement is accepted by an agent that trusts the endorser", async () => {
    const phone = await generateDeviceKeys();
    const browser = await generateDeviceKeys();
    const pub = await publicKeys(browser);
    const e = await signEndorsement(phone, {
      uid: "u1",
      newDeviceId: browser.deviceId,
      pubSign: pub.pubSign,
      pubBox: pub.pubBox,
      now: NOW,
    });
    expect(Endorsement.safeParse(e).success).toBe(true);
    const list = new TrustedClientList("dev_agent");
    const pp = await publicKeys(phone);
    await list.addConfirmed({ deviceId: phone.deviceId, pubSign: pp.pubSign, pubBox: pp.pubBox }, NOW);
    expect(await list.addEndorsed(e, NOW + 1000)).toEqual({ ok: true, passkey: false });
    expect(list.has(browser.deviceId)).toBe(true);
  });

  it("sealed content opens only for the named devices", async () => {
    const agent = await generateDeviceKeys();
    const pub = await publicKeys(agent);
    const env = await sealFor({ prompt: "hola" }, { [agent.deviceId]: pub.pubBox }, "command:c1");
    expect(await openJson(env, agent.deviceId, agent.box, "command:c1")).toEqual({ prompt: "hola" });
    await expect(openJson(env, agent.deviceId, agent.box, "command:c2")).rejects.toThrow();
  });
});

describe.each([[-7 as const], [-8 as const]])("decision with passkey step-up (COSE alg %s)", (alg) => {
  it("is bound to the decision and verifies on the agent", async () => {
    const phone = await generateDeviceKeys();
    const auth = new SoftAuthenticator({ origin: ORIGIN, alg });
    const credential = { credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP };
    const d = await signDecision(phone, {
      uid: "u1",
      aid: "a1",
      requestId: "r1",
      targetDeviceId: "dev_agent",
      allow: true,
      now: NOW,
      stepUp: stepUpWithPasskey(credential, auth),
    });
    expect(Decision.safeParse(d).success).toBe(true);
    expect(d.body.stepUp?.method).toBe("webauthn");

    const list = new TrustedClientList("dev_agent");
    const pp = await publicKeys(phone);
    await list.addConfirmed(
      { deviceId: phone.deviceId, pubSign: pp.pubSign, pubBox: pp.pubBox, webauthn: credential },
      NOW,
    );
    expect((await list.verifyDecision(d, { aid: "a1", requestId: "r1" }, NOW + 1, new MemoryNonceStore())).ok).toBe(
      true,
    );
    const res = await verifyWebAuthnAssertion({
      assertion: d.body.stepUp!.assertion!,
      credential,
      expectedChallenge: await stepUpChallenge(d.body),
      rpId: RP,
      origin: ORIGIN,
    });
    expect(res.ok).toBe(true);

    // The same assertion can't be reused for the opposite verdict.
    const flipped = await stepUpChallenge({ ...d.body, allow: false });
    expect(
      (
        await verifyWebAuthnAssertion({
          assertion: d.body.stepUp!.assertion!,
          credential,
          expectedChallenge: flipped,
          rpId: RP,
          origin: ORIGIN,
        })
      ).ok,
    ).toBe(false);
    expect(await fromB64url(d.sig)).toHaveLength(64);
  });
});
