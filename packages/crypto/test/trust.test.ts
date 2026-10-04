import { describe, expect, it } from "vitest";
import type { DecisionBody } from "@chalito/protocol";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
  fromB64url,
} from "../src/index.js";

const now = 1_790_000_000_000;

const client = async (deviceId: string) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { deviceId, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

const decide = async (c: Awaited<ReturnType<typeof client>>, over: Partial<DecisionBody> = {}) =>
  signEnvelope<DecisionBody>(
    "chalito.decision.v1",
    {
      v: 1,
      aid: "a1",
      requestId: "r1",
      uid: "u1",
      targetDeviceId: "agent1",
      allow: true,
      nonce: await randomNonce(),
      issuedAt: now,
      expiresAt: now + 60_000,
      ...over,
    },
    c.deviceId,
    c.sign.secretKey,
  );

const expected = { aid: "a1", requestId: "r1" };

describe("TrustedClientList", () => {
  it("accepts a decision from a locally confirmed phone", async () => {
    const phone = await client("phone1");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    expect(await list.verifyDecision(await decide(phone), expected, now, new MemoryNonceStore())).toEqual({
      ok: true,
      signerDeviceId: "phone1",
    });
  });

  it("rejects a revoked phone's signature even if the server still delivers it", async () => {
    const phone = await client("phone1");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    const d = await decide(phone);
    list.remove("phone1");
    expect(await list.verifyDecision(d, expected, now, new MemoryNonceStore())).toEqual({
      ok: false,
      reason: "untrusted_signer",
    });
  });

  it("rejects a key the server added but the device never trusted (approver injection / recovery alone)", async () => {
    const phone = await client("phone1");
    const recovered = await client("phone2");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    expect((await list.verifyDecision(await decide(recovered), expected, now, new MemoryNonceStore())).ok).toBe(false);
  });

  it("a new phone becomes trusted only through an endorsement by a trusted phone", async () => {
    const phone = await client("phone1");
    const newPhone = await client("phone2");
    const stranger = await client("evil");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    const body = {
      v: 1 as const,
      uid: "u1",
      newDeviceId: "phone2",
      pubSign: newPhone.pubSign,
      pubBox: newPhone.pubBox,
      issuedAt: now,
    };
    expect(
      (await list.addEndorsed(await signEnvelope("chalito.endorsement.v1", body, "evil", stranger.sign.secretKey), now))
        .ok,
    ).toBe(false);
    expect(list.has("phone2")).toBe(false);
    expect(
      (await list.addEndorsed(await signEnvelope("chalito.endorsement.v1", body, "phone1", phone.sign.secretKey), now))
        .ok,
    ).toBe(true);
    expect((await list.verifyDecision(await decide(newPhone), expected, now, new MemoryNonceStore())).ok).toBe(true);
  });

  it("rejects wrong device, wrong request, expiry and replay", async () => {
    const phone = await client("phone1");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    const nonces = new MemoryNonceStore();
    expect(await list.verifyDecision(await decide(phone, { targetDeviceId: "agent2" }), expected, now, nonces)).toEqual(
      { ok: false, reason: "wrong_device" },
    );
    expect(await list.verifyDecision(await decide(phone, { requestId: "r2" }), expected, now, nonces)).toEqual({
      ok: false,
      reason: "wrong_request",
    });
    expect(await list.verifyDecision(await decide(phone, { expiresAt: now }), expected, now, nonces)).toEqual({
      ok: false,
      reason: "expired_decision",
    });
    const d = await decide(phone);
    expect((await list.verifyDecision(d, expected, now, nonces)).ok).toBe(true);
    expect(await list.verifyDecision(d, expected, now + 1, nonces)).toEqual({ ok: false, reason: "replayed_nonce" });
  });

  it("after revocation, newly sealed content isn't decryptable with the revoked key", async () => {
    const [a, b] = await Promise.all([client("phone1"), client("laptop1")]);
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(a, now);
    await list.addConfirmed(b, now);
    list.remove("laptop1");
    const recipients = Object.fromEntries(
      await Promise.all(Object.entries(list.recipients()).map(async ([id, k]) => [id, await fromB64url(k)] as const)),
    );
    const env = await sealJson({ x: 1 }, recipients);
    await expect(openJson(env, "laptop1", b.box)).rejects.toThrow();
    expect(await openJson(env, "phone1", a.box)).toEqual({ x: 1 });
  });

  it("round-trips through JSON without changing trust", async () => {
    const phone = await client("phone1");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    const again = await TrustedClientList.fromJSON("agent1", list.toJSON());
    expect((await again.verifyDecision(await decide(phone), expected, now, new MemoryNonceStore())).ok).toBe(true);
  });
});

describe("TrustedClientList passkeys", () => {
  it("records a passkey only for a locally trusted client and keeps it through toJSON/fromJSON", async () => {
    const List = TrustedClientList;
    const list = new List("dev_agent");
    const cred = { credentialId: "cid", publicKey: "pk", rpId: "chalito.chalyb.com" };
    expect(list.setWebAuthn("dev_phone", cred)).toBe(false);
    await list.addConfirmed({ deviceId: "dev_phone", pubSign: "A".repeat(43), pubBox: "B".repeat(43) }, 1);
    expect(list.webauthnFor("dev_phone")).toBeUndefined();
    expect(list.setWebAuthn("dev_phone", cred)).toBe(true);
    const back = await List.fromJSON("dev_agent", list.toJSON());
    expect(back.webauthnFor("dev_phone")).toEqual(cred);
    back.remove("dev_phone");
    expect(back.webauthnFor("dev_phone")).toBeUndefined();
  });
});

describe("endorsement introduces agents (ADR 0018)", () => {
  const setup = async () => {
    const phone = await client("phone1");
    const newClient = await client("desk2");
    const list = new TrustedClientList("agent1");
    await list.addConfirmed(phone, now);
    const agentKey = await generateSigningKeyPair();
    const agentBox = await generateBoxKeyPair();
    const intro = (deviceId: string) => ({
      deviceId,
      pubSign: "",
      pubBox: "",
      fingerprint: "FP",
    });
    const base = {
      v: 1 as const,
      uid: "u1",
      newDeviceId: "desk2",
      pubSign: newClient.pubSign,
      pubBox: newClient.pubBox,
      issuedAt: now,
    };
    const agentEntry = async (deviceId: string) => ({
      ...intro(deviceId),
      pubSign: await toB64url(agentKey.publicKey),
      pubBox: await toB64url(agentBox.publicKey),
    });
    const endorse = async (body: Record<string, unknown>) =>
      signEnvelope("chalito.endorsement.v1", { ...base, ...body }, "phone1", phone.sign.secretKey);
    return { phone, newClient, list, base, endorse, agentEntry };
  };

  it("an agent accepts the endorsed client only when it's in the endorsement's agent list", async () => {
    const s = await setup();
    expect((await s.list.addEndorsed(await s.endorse({ agents: [await s.agentEntry("agent9")] }), now)).ok).toBe(false);
    expect(s.list.has("desk2")).toBe(false);
    const e = await s.endorse({ agents: [await s.agentEntry("agent9"), await s.agentEntry("agent1")] });
    expect((await s.list.addEndorsed(e, now)).ok).toBe(true);
    expect(s.list.toJSON().find((c) => c.deviceId === "desk2")).toMatchObject({
      via: "endorsement",
      endorsedBy: "phone1",
    });
  });

  it("tampering with the agent list breaks the signature", async () => {
    const s = await setup();
    const e = await s.endorse({ agents: [await s.agentEntry("agent9")] });
    // Someone on the path adds this agent to an endorsement that didn't name it.
    const tampered = {
      ...e,
      body: {
        ...e.body,
        agents: [...(e.body as unknown as { agents: unknown[] }).agents, await s.agentEntry("agent1")],
      },
    };
    expect((await s.list.addEndorsed(tampered as never, now)).ok).toBe(false);
    expect(s.list.has("desk2")).toBe(false);
  });

  it("an endorsement without a list (older format) is accepted as before", async () => {
    const s = await setup();
    expect((await s.list.addEndorsed(await s.endorse({}), now)).ok).toBe(true);
  });

  it("removal is final: the stored endorsement never brings a revoked client back", async () => {
    const s = await setup();
    const e = await s.endorse({ agents: [await s.agentEntry("agent1")] });
    expect((await s.list.addEndorsed(e, now)).ok).toBe(true);
    expect(s.list.remove("desk2")).toBe(true);
    expect((await s.list.addEndorsed(e, now)).ok).toBe(false);
    expect(s.list.removedIds()).toEqual(["desk2"]);
    // A local re-pair (the person confirms the fingerprint here) is the way back.
    await s.list.addConfirmed(s.newClient, now);
    expect(s.list.isRemoved("desk2")).toBe(false);
    const restored = await TrustedClientList.fromJSON("agent1", s.list.toJSON(), ["x"]);
    expect(restored.removedIds()).toEqual(["x"]);
  });

  it("accepts up to 7 days old, not older, and not from the future", async () => {
    const s = await setup();
    const old = await s.endorse({ issuedAt: now - 6 * 24 * 3600_000 });
    expect((await s.list.addEndorsed(old, now)).ok).toBe(true);
    const s2 = await setup();
    expect((await s2.list.addEndorsed(await s2.endorse({ issuedAt: now - 8 * 24 * 3600_000 }), now)).ok).toBe(false);
    expect((await s2.list.addEndorsed(await s2.endorse({ issuedAt: now + 5 * 60_000 }), now)).ok).toBe(false);
  });
});
