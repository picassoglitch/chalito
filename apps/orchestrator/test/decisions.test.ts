import { describe, expect, it } from "vitest";
import { generateSigningKeyPair, randomNonce, signEnvelope, toB64url, type SigningKeyPair } from "@chalito/crypto";
import type { DecisionBody } from "@chalito/protocol";
import { OWNER, harness } from "./harness.js";

/** A Mesa decision binds only after its signature is verified against the signer's stored key. */
const NOW = 1_790_000_000_000;

const setup = async () => {
  const h = await harness();
  const phone = await generateSigningKeyPair();
  const tablet = await generateSigningKeyPair();
  h.store.signKeys.set(`${OWNER}/dev_phone`, await toB64url(phone.publicKey));
  h.store.signKeys.set(`${OWNER}/dev_tablet`, await toB64url(tablet.publicKey));
  await h.store.createDecisionApproval(OWNER, {
    aid: "apr_1",
    mid: h.mid,
    tid: "t_1",
    origin: "client:dev_phone",
    detailsCt: { alg: "xchacha20poly1305+sealedbox", nonce: "n", ct: "c", keys: {} },
  });
  const body = async (over: Partial<DecisionBody> = {}): Promise<DecisionBody> => ({
    v: 1,
    aid: "apr_1",
    requestId: "t_1",
    uid: OWNER,
    targetDeviceId: "orchestrator",
    allow: true,
    choice: 1,
    nonce: await randomNonce(),
    issuedAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    ...over,
  });
  /** What a client inserts into approval_decisions (RLS: signer = its own device). */
  const answer = async (signer: string, decision: unknown) => {
    h.store.decisions.push({ owner: OWNER, aid: "apr_1", signer, decision });
    const res = await h.app.request("/v1/decisions/apr_1/check", {
      method: "POST",
      headers: { authorization: "Bearer phone-token" },
    });
    const { status } = (await res.json()) as { status: string };
    return { status };
  };
  const sign = (b: DecisionBody, signer: string, keys: SigningKeyPair) =>
    signEnvelope("chalito.decision.v1", b, signer, keys.secretKey);
  const status = () => h.store.approvals[0]!.status;
  return { h, phone, tablet, body, answer, sign, status };
};

describe("Mesa decisions resolve only on a verified signature", () => {
  it("a valid signed answer resolves it (choice kept) and is audited", async () => {
    const s = await setup();
    expect(await s.answer("dev_phone", await s.sign(await s.body({ allow: false }), "dev_phone", s.phone))).toEqual({
      status: "denied",
    });
    expect(s.status()).toBe("denied");
    expect(s.h.audits).toEqual([
      { action: "decision.resolved", owner: OWNER, target: "apr_1", meta: { signer: "dev_phone", status: "denied" } },
    ]);
  });

  it("an unsigned or garbage envelope from a stolen client token never resolves; later garbage neither; the first VALID answer wins", async () => {
    const s = await setup();
    const forged = {
      ctx: "chalito.decision.v1",
      signerDeviceId: "dev_phone",
      body: await s.body(),
      sig: "A".repeat(86),
    };
    expect(await s.answer("dev_phone", forged)).toEqual({ status: "pending" });
    expect(await s.answer("dev_phone", { garbage: true })).toEqual({ status: "pending" });
    expect(s.status()).toBe("pending");
    expect(s.h.audits.map((a) => [a.action, a.meta.reason])).toEqual([
      ["decision.invalid_signature", "invalid_signature"],
    ]);
    // Re-polling doesn't re-audit the same rejected answer.
    await s.answer("dev_phone", forged);
    expect(s.h.audits.filter((a) => a.action === "decision.invalid_signature")).toHaveLength(1);
    // A signature by another device's key, claiming to be the phone, is invalid too.
    const s2 = await setup();
    expect(await s2.answer("dev_phone", await s2.sign(await s2.body(), "dev_phone", s2.tablet))).toEqual({
      status: "pending",
    });
    // A properly signed answer from another active client resolves it.
    expect(await s.answer("dev_tablet", await s.sign(await s.body(), "dev_tablet", s.tablet))).toEqual({
      status: "approved",
    });
  });

  it("a revoked signer is refused", async () => {
    const s = await setup();
    s.h.store.revoked.add(`${OWNER}/dev_phone`);
    expect(await s.answer("dev_phone", await s.sign(await s.body(), "dev_phone", s.phone))).toEqual({
      status: "pending",
    });
    expect(s.h.audits[0]!.meta.reason).toBe("untrusted_signer");
  });

  it("binding: wrong approval, request, owner, target, expired, or a reused nonce", async () => {
    for (const [over, reason] of [
      [{ aid: "apr_other" }, "wrong_approval"],
      [{ requestId: "t_other" }, "wrong_approval"],
      [{ uid: "someone-else" }, "wrong_target"],
      [{ targetDeviceId: "dev_agent" }, "wrong_target"],
      [{ issuedAt: NOW - 120_000, expiresAt: NOW - 1 }, "expired"],
    ] as const) {
      const s = await setup();
      expect(await s.answer("dev_phone", await s.sign(await s.body(over), "dev_phone", s.phone))).toEqual({
        status: "pending",
      });
      expect(s.h.audits[0]!.meta.reason).toBe(reason);
    }
    const s = await setup();
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
    s.h.store.decisions.push({ owner: OWNER, aid: "apr_old", signer: "dev_phone", decision: { body: { nonce } } });
    expect(await s.answer("dev_phone", await s.sign(await s.body({ nonce }), "dev_phone", s.phone))).toEqual({
      status: "pending",
    });
    expect(s.h.audits[0]!.meta.reason).toBe("replayed_nonce");
  });

  it("the scheduled sweep needs Google OIDC and resolves pending answers nobody poked about", async () => {
    const s = await setup();
    s.h.store.decisions.push({
      owner: OWNER,
      aid: "apr_1",
      signer: "dev_phone",
      decision: await s.sign(await s.body(), "dev_phone", s.phone),
    });
    expect((await s.h.app.request("/tasks/sweep-decisions", { method: "POST" })).status).toBe(401);
    const res = await s.h.app.request("/tasks/sweep-decisions", {
      method: "POST",
      headers: { authorization: "Bearer scheduler-oidc" },
    });
    expect(await res.json()).toEqual({ resolved: 1, invalid: 0 });
    expect(s.status()).toBe("approved");
  });
});
