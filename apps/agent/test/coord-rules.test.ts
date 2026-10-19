import {
  TrustedClientList,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
  type SigningKeyPair,
} from "@chalito/crypto";
import { describe, expect, it } from "vitest";
import { CoordRules } from "../src/coord/rules.js";

const OWNER = "owner_1";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const keys = async () => {
  const sign = await generateSigningKeyPair();
  const box = await toB64url(new Uint8Array(32));
  return { sign, box };
};

const rule = (k: SigningKeyPair, signer: string, over: Record<string, unknown> = {}) =>
  signEnvelope(
    "chalito.coordrule.v1",
    {
      v: 1,
      ruleId: `cr_${Math.random().toString(36).slice(2, 12)}`,
      uid: OWNER,
      match: "b".repeat(64),
      createdAt: NOW - DAY,
      expiresAt: NOW + DAY,
      ...over,
    },
    signer,
    k.secretKey,
  );

const setup = async () => {
  const phone = await keys();
  const stranger = await keys();
  const trust = new TrustedClientList("dev_agent");
  await trust.addConfirmed(
    { deviceId: "dev_phone", pubSign: await toB64url(phone.sign.publicKey), pubBox: phone.box },
    NOW,
  );
  let rows: unknown[] = [];
  let fail = false;
  let now = NOW;
  const rules = new CoordRules({
    list: async () => {
      if (fail) throw new Error("offline");
      return rows;
    },
    trust: () => trust,
    owner: OWNER,
    now: () => now,
    refreshMs: 1000,
  });
  return {
    phone,
    stranger,
    trust,
    rules,
    set: (r: unknown[]) => void (rows = r),
    fail: (f: boolean) => void (fail = f),
    tick: (ms: number) => void (now += ms),
  };
};

describe("remembered rules verify on the device", () => {
  it("keeps a rule signed by a locally trusted client", async () => {
    const h = await setup();
    h.set([await rule(h.phone.sign, "dev_phone")]);
    expect([...(await h.rules.matches())]).toEqual(["b".repeat(64)]);
  });

  it("drops what the cloud could forge: another signer, another owner, a bad signature", async () => {
    const h = await setup();
    const good = await rule(h.phone.sign, "dev_phone", { match: "c".repeat(64) });
    h.set([
      await rule(h.stranger.sign, "dev_phone"), // claims the phone, signed by someone else
      await rule(h.stranger.sign, "dev_stranger"),
      await rule(h.phone.sign, "dev_phone", { uid: "someone_else" }),
      { ...good, body: { ...good.body, match: "d".repeat(64) } }, // widened after signing
      { garbage: true },
    ]);
    expect((await h.rules.matches()).size).toBe(0);
  });

  it("drops expired rules and ones made in the future", async () => {
    const h = await setup();
    h.set([
      await rule(h.phone.sign, "dev_phone", { createdAt: NOW - 3 * DAY, expiresAt: NOW - 1 }),
      await rule(h.phone.sign, "dev_phone", { createdAt: NOW + DAY, expiresAt: NOW + 2 * DAY }),
    ]);
    expect((await h.rules.matches()).size).toBe(0);
  });

  it("a client removed here takes its rules with it", async () => {
    const h = await setup();
    h.set([await rule(h.phone.sign, "dev_phone")]);
    expect((await h.rules.matches()).size).toBe(1);
    h.trust.remove("dev_phone");
    h.rules.invalidate();
    expect((await h.rules.matches()).size).toBe(0);
  });

  it("a rule deleted in the cloud stops matching after the refresh window", async () => {
    const h = await setup();
    h.set([await rule(h.phone.sign, "dev_phone")]);
    expect((await h.rules.matches()).size).toBe(1);
    h.set([]);
    expect((await h.rules.matches()).size).toBe(1); // cached
    h.tick(1001);
    expect((await h.rules.matches()).size).toBe(0);
  });

  it("an outage keeps the last good set for one more window, then none", async () => {
    const h = await setup();
    h.set([await rule(h.phone.sign, "dev_phone")]);
    await h.rules.matches();
    h.fail(true);
    h.tick(1500);
    expect((await h.rules.matches()).size).toBe(1);
    h.tick(1000);
    expect((await h.rules.matches()).size).toBe(0);
  });
});
