import { describe, expect, it } from "vitest";
import { fingerprint, randomNonce } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import type { Endorsement } from "@chalito/protocol";
import {
  DeviceClientKeys,
  approveEndorsement,
  generateDeviceKeys,
  introducedAgents,
  publicKeys,
  type ApiClient,
  type DirectoryDevice,
  type TrustedAgent,
} from "../src/index.js";

const NOW = 1_790_000_000_000;
const UID = "u1";

const dev = async () => {
  const keys = await generateDeviceKeys();
  const pub = await publicKeys(keys);
  return { keys, ...pub, deviceId: keys.deviceId, fp: await fingerprint(keys.sign.publicKey) };
};
type Dev = Awaited<ReturnType<typeof dev>>;
const asAgent = (a: Dev, over: Partial<TrustedAgent> = {}): TrustedAgent => ({
  deviceId: a.deviceId,
  pubSign: a.pubSign,
  pubBox: a.pubBox,
  fingerprint: a.fp,
  label: "Laptop",
  confirmedAt: NOW,
  ...over,
});
const row = (d: Dev, role: DirectoryDevice["role"], over: Partial<DirectoryDevice> = {}): DirectoryDevice => ({
  deviceId: d.deviceId,
  role,
  revoked: false,
  pubSign: d.pubSign,
  pubBox: d.pubBox,
  ...over,
});

/** The trusted phone endorses `desk`, introducing its glyph-confirmed agents; returns what it posted. */
const approve = async (phone: Dev, desk: Dev, agents: TrustedAgent[]) => {
  let posted: Endorsement | null = null;
  const api: ApiClient = {
    post: async <T>(_p: string, body: unknown) => (
      (posted = (body as { endorsement: Endorsement }).endorsement),
      {} as T
    ),
  };
  const reg = {
    ctx: "chalito.device-register.v1",
    body: {
      v: 1,
      owner: UID,
      deviceId: desk.deviceId,
      kind: "web",
      platform: "web",
      name: "Desk",
      pubSign: desk.pubSign,
      pubBox: desk.pubBox,
      issuedAt: NOW,
    },
    signerDeviceId: desk.deviceId,
    sig: "x",
  } as never;
  await approveEndorsement(
    api,
    await DeviceClientKeys.create(phone.keys),
    { codeId: "c", registration: reg },
    { uid: UID, now: NOW, agents },
  );
  return posted!;
};

describe("ADR 0018: the endorsement introduces the endorser's agents", () => {
  it("passes on only glyph-confirmed agents (no chains), signed with the rest", async () => {
    const [phone, desk, laptop, viaEndorsement] = await Promise.all([dev(), dev(), dev(), dev()]);
    const e = await approve(phone, desk, [
      asAgent(laptop),
      asAgent(viaEndorsement, { via: "endorsement", endorsedBy: "x" }),
    ]);
    expect(e.body.agents).toEqual([
      { deviceId: laptop.deviceId, pubSign: laptop.pubSign, pubBox: laptop.pubBox, fingerprint: laptop.fp },
    ]);
  });

  it("the new client trusts an introduced agent only when the endorsement AND the directory agree", async () => {
    const [phone, desk, laptop, tower] = await Promise.all([dev(), dev(), dev(), dev()]);
    const e = await approve(phone, desk, [asAgent(laptop), asAgent(tower)]);
    const self = { uid: UID, deviceId: desk.deviceId, pubSign: desk.pubSign, pubBox: desk.pubBox };
    const swapped = await dev();
    const r = await introducedAgents(e, self, [
      row(phone, "client"),
      row(laptop, "agent"),
      // The server swapped this agent's keys: refused.
      row(tower, "agent", { pubBox: swapped.pubBox }),
    ]);
    expect(r).toEqual({
      ok: true,
      agents: [{ deviceId: laptop.deviceId, pubSign: laptop.pubSign, pubBox: laptop.pubBox, fingerprint: laptop.fp }],
      dropped: [{ deviceId: tower.deviceId, reason: "key_mismatch" }],
    });
  });

  it.each([
    ["not in the directory", (_l: Dev) => [] as DirectoryDevice[], "not_in_directory"],
    ["revoked", (l: Dev) => [row(l, "agent", { revoked: true })], "revoked"],
    ["listed as a client", (l: Dev) => [row(l, "client")], "not_an_agent"],
  ] as const)("drops an agent that is %s", async (_n, rows, reason) => {
    const [phone, desk, laptop] = await Promise.all([dev(), dev(), dev()]);
    const e = await approve(phone, desk, [asAgent(laptop)]);
    const r = await introducedAgents(
      e,
      { uid: UID, deviceId: desk.deviceId, pubSign: desk.pubSign, pubBox: desk.pubBox },
      [row(phone, "client"), ...rows(laptop)],
    );
    expect(r).toMatchObject({ ok: true, agents: [], dropped: [{ deviceId: laptop.deviceId, reason }] });
  });

  it("a wrong fingerprint for an agent (consistent keys, lying fingerprint) is dropped", async () => {
    const [phone, desk, laptop] = await Promise.all([dev(), dev(), dev()]);
    const e = await approve(phone, desk, [asAgent(laptop, { fingerprint: "AAAA-BBBB" })]);
    const r = await introducedAgents(
      e,
      { uid: UID, deviceId: desk.deviceId, pubSign: desk.pubSign, pubBox: desk.pubBox },
      [row(phone, "client"), row(laptop, "agent")],
    );
    expect(r).toMatchObject({ ok: true, dropped: [{ reason: "fingerprint_mismatch" }] });
  });

  it("refuses everything when the endorsement isn't genuine or isn't for this device", async () => {
    const [phone, desk, laptop, other] = await Promise.all([dev(), dev(), dev(), dev()]);
    const e = await approve(phone, desk, [asAgent(laptop)]);
    const self = { uid: UID, deviceId: desk.deviceId, pubSign: desk.pubSign, pubBox: desk.pubBox };
    const dir = [row(phone, "client"), row(laptop, "agent"), row(other, "agent")];
    // Tampering with the list (adding an agent) breaks the signature.
    const tampered = {
      ...e,
      body: {
        ...e.body,
        agents: [
          ...e.body.agents!,
          { deviceId: other.deviceId, pubSign: other.pubSign, pubBox: other.pubBox, fingerprint: other.fp },
        ],
      },
    };
    expect(await introducedAgents(tampered, self, dir)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await introducedAgents(e, self, [row(laptop, "agent")])).toEqual({ ok: false, reason: "endorser_unknown" });
    expect(await introducedAgents(e, self, [row(phone, "client", { revoked: true })])).toEqual({
      ok: false,
      reason: "endorser_unknown",
    });
    // The directory swapped the endorser's key: the signature no longer verifies.
    expect(await introducedAgents(e, self, [row(phone, "client", { pubSign: other.pubSign })])).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await introducedAgents(e, { ...self, deviceId: other.deviceId }, dir)).toEqual({
      ok: false,
      reason: "not_for_this_device",
    });
  });

  it("stores introduced agents, upgrades on a later glyph check, never downgrades a glyph-confirmed one", async () => {
    const [desk, laptop, tower] = await Promise.all([dev(), dev(), dev()]);
    const keys = await DeviceClientKeys.create(desk.keys);
    // `tower` confirmed by glyph first.
    const glyph = await signGlyph(
      {
        v: 1,
        purpose: "pair_device",
        codeId: "code_12345678",
        issuerPubSign: tower.pubSign,
        issuerPubBox: tower.pubBox,
        label: "Tower",
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
        nonce: await randomNonce(),
      },
      tower.keys.sign.secretKey,
    );
    await keys.trustAgentFromGlyph(glyph, tower.fp, NOW);
    const intro = [laptop, tower].map((a) => ({
      deviceId: a.deviceId,
      pubSign: a.pubSign,
      pubBox: a.pubBox,
      fingerprint: a.fp,
    }));
    expect(await keys.trustIntroducedAgents(intro, "phone1", NOW)).toEqual([laptop.deviceId]);
    expect(keys.trustedAgents().find((a) => a.deviceId === tower.deviceId)?.via).toBeUndefined();
    expect(keys.trustedAgents().find((a) => a.deviceId === laptop.deviceId)).toMatchObject({
      via: "endorsement",
      endorsedBy: "phone1",
    });
    expect(keys.trustedAgentBoxKey(laptop.deviceId)).toBe(laptop.pubBox);
  });
});

describe("R-L13: the endorser's passkey step-up is bound to the endorsement body", () => {
  it("the assertion covers this exact body (agents and the api verify the same proof); cancelling sends nothing", async () => {
    const { SoftAuthenticator } = await import("../src/testing/soft-authenticator.js");
    const { stepUpChallenge, verifyWebAuthnAssertion } = await import("@chalito/crypto");
    const { stepUpWithPasskey } = await import("../src/index.js");
    const [phone, desk, laptop] = await Promise.all([dev(), dev(), dev()]);
    const auth = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
    const ref = { credentialId: auth.credentialId, rpId: "chalito.chalyb.com" };
    let posted: { endorsement: Endorsement } | null = null;
    const api: ApiClient = {
      post: async <T>(_p: string, body: unknown) => ((posted = body as { endorsement: Endorsement }), {} as T),
    };
    const reg = {
      ctx: "chalito.device-register.v1",
      body: {
        v: 1,
        owner: UID,
        deviceId: desk.deviceId,
        kind: "web",
        platform: "web",
        name: "Desk",
        pubSign: desk.pubSign,
        pubBox: desk.pubBox,
        issuedAt: NOW,
      },
      signerDeviceId: desk.deviceId,
      sig: "x",
    } as never;
    const keys = await DeviceClientKeys.create(phone.keys);
    await approveEndorsement(
      api,
      keys,
      { codeId: "c", registration: reg },
      {
        uid: UID,
        now: NOW,
        agents: [asAgent(laptop)],
        stepUp: stepUpWithPasskey(ref, { create: async () => ({}) as never, get: (o) => auth.get(o) }),
      },
    );
    const e = posted!.endorsement;
    expect(Object.keys(posted!).sort()).toEqual(["codeId", "endorsement"]); // no separate server-challenge field
    expect(e.body.stepUp?.method).toBe("webauthn");
    const check = await verifyWebAuthnAssertion({
      assertion: e.body.stepUp!.assertion,
      credential: { credentialId: auth.credentialId, publicKey: auth.publicKey },
      expectedChallenge: await stepUpChallenge(e.body),
      rpId: "chalito.chalyb.com",
      origin: "https://chalito.chalyb.com",
    });
    expect(check.ok).toBe(true);

    posted = null;
    await expect(
      approveEndorsement(
        api,
        keys,
        { codeId: "c", registration: reg },
        {
          uid: UID,
          now: NOW,
          stepUp: () => Promise.reject(new DOMException("cancelled", "NotAllowedError")),
        },
      ),
    ).rejects.toThrow();
    expect(posted).toBeNull();
  });
});
