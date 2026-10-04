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
      await list.addEndorsed(await signEnvelope("chalito.endorsement.v1", body, "evil", stranger.sign.secretKey), now),
    ).toBe(false);
    expect(list.has("phone2")).toBe(false);
    expect(
      await list.addEndorsed(await signEnvelope("chalito.endorsement.v1", body, "phone1", phone.sign.secretKey), now),
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
