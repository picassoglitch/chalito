import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ClientKeys, StepUpProvider } from "@chalito/client";
import { fingerprint, randomNonce, stepUpChallenge, verifyEnvelope, verifyWebAuthnAssertion } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import { DeviceClientKeys, KeyVault, generateDeviceKeys, passkeyStepUp, publicKeys } from "../src/index.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const NOW = 1_790_000_000_000;
const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;

const glyphFor = async (agent: Awaited<ReturnType<typeof generateDeviceKeys>>) => {
  const pub = await publicKeys(agent);
  return signGlyph(
    {
      v: 1,
      purpose: "pair_device",
      codeId: "code_abcdefgh",
      issuerPubSign: pub.pubSign,
      issuerPubBox: pub.pubBox,
      label: "Escritorio",
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      nonce: (await randomNonce()).slice(0, 22),
    },
    agent.sign.secretKey,
  );
};

describe("DeviceClientKeys (packages/client ClientKeys)", () => {
  it("satisfies the data layer's ClientKeys and StepUpProvider types", async () => {
    const keys: ClientKeys = await DeviceClientKeys.create(await generateDeviceKeys());
    const provider: StepUpProvider = passkeyStepUp(null);
    expect(keys.deviceId).toMatch(/^dev_/);
    expect(await provider({ aid: "a", risk: "HIGH", agentDeviceId: "dev_x" })).toBeNull();
  });

  it("signs, seals and opens with keys it never exposes", async () => {
    const dk = await generateDeviceKeys();
    const keys = await DeviceClientKeys.create(dk);
    const env = await keys.sign("chalito.command.v1", { hello: 1 });
    expect((await verifyEnvelope(env, "chalito.command.v1", new Map([[dk.deviceId, dk.sign.publicKey]]))).ok).toBe(
      true,
    );
    const sealed = await keys.seal({ a: 1 }, { [keys.deviceId]: keys.pubBox }, "approval:a1");
    expect(await keys.open(sealed, "approval:a1")).toEqual({ a: 1 });
    expect(Object.values(keys).some((v) => v === dk.sign.secretKey || v === dk)).toBe(false);
  });

  it("trusts an agent's box key only after a verified glyph and the confirmed fingerprint, and persists it", async () => {
    const idb = new IDBFactory();
    const vault = await KeyVault.open("t", { indexedDB: idb });
    const dk = await generateDeviceKeys();
    await vault.save(dk);
    const keys = await DeviceClientKeys.create(dk, vault);
    const agent = await generateDeviceKeys();
    const g = await glyphFor(agent);
    expect(keys.trustedAgentBoxKey(agent.deviceId)).toBeNull();
    await expect(keys.trustAgentFromGlyph(g, "0000-0000-0000-0000", NOW + 1)).rejects.toThrow(/fingerprint/);
    const forged = { ...g, body: { ...g.body, issuerPubBox: (await publicKeys(await generateDeviceKeys())).pubBox } };
    await expect(keys.trustAgentFromGlyph(forged, await fingerprint(agent.sign.publicKey), NOW + 1)).rejects.toThrow(
      /untrusted glyph/,
    );
    await keys.trustAgentFromGlyph(g, await fingerprint(agent.sign.publicKey), NOW + 1);
    expect(keys.trustedAgentBoxKey(agent.deviceId)).toBe((await publicKeys(agent)).pubBox);

    const reloaded = await DeviceClientKeys.create(
      (await (await KeyVault.open("t", { indexedDB: idb })).load())!,
      await KeyVault.open("t", { indexedDB: idb }),
    );
    expect(reloaded.trustedAgentBoxKey(agent.deviceId)).toBe((await publicKeys(agent)).pubBox);
    expect(await reloaded.forgetAgent(agent.deviceId)).toBe(true);
    expect(reloaded.trustedAgentBoxKey(agent.deviceId)).toBeNull();
  });
});

describe("passkeyStepUp", () => {
  it("binds the assertion to the unsigned decision body", async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const credential = { credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP };
    const provider = passkeyStepUp(credential, { ceremonies: auth, now: () => NOW });
    const body = {
      v: 1,
      aid: "a1",
      requestId: "r1",
      uid: "u1",
      targetDeviceId: "dev_agent",
      allow: true,
      nonce: "n".repeat(22),
      issuedAt: NOW,
      expiresAt: NOW + 1000,
    };
    const step = await provider({ aid: "a1", risk: "HIGH", agentDeviceId: "dev_agent" }, body);
    expect(step?.method).toBe("webauthn");
    const res = await verifyWebAuthnAssertion({
      assertion: step!.assertion as never,
      credential,
      expectedChallenge: await stepUpChallenge(body),
      rpId: RP,
      origin: ORIGIN,
    });
    expect(res.ok).toBe(true);
    await expect(provider({ aid: "a1", risk: "HIGH", agentDeviceId: "dev_agent" })).rejects.toThrow(
      /unsigned decision body/,
    );
  });
});
