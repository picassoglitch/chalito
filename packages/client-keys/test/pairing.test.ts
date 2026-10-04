import { describe, expect, it } from "vitest";
import { fingerprint, randomNonce, toB64url, verifyEnvelope } from "@chalito/crypto";
import { renderGlyphFrames, signGlyph } from "@chalito/glyph";
import { ClaimPairingRequest, SignedCommand, type GlyphPayload } from "@chalito/protocol";
import {
  PairingScanner,
  agentFromGlyph,
  buildEndorsedEnrolment,
  buildPairingClaim,
  generateDeviceKeys,
  publicKeys,
  resolveShortCode,
  revokeDevice,
  signDeviceRegistration,
  type ApiClient,
  type DeviceKeys,
} from "../src/index.js";

const NOW = 1_790_000_000_000;

const agentGlyph = async (agent: DeviceKeys, over: Partial<GlyphPayload["body"]> = {}) => {
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
      expiresAt: NOW + 4 * 60_000,
      nonce: (await randomNonce()).slice(0, 22),
      ...over,
    },
    agent.sign.secretKey,
  );
};

const scan = async (g: GlyphPayload, now = NOW + 1000) => {
  const scanner = new PairingScanner(() => now);
  for (const img of renderGlyphFrames(g, 240)) {
    const r = await scanner.pushFrame(img);
    if (r.state !== "scanning") return r;
  }
  return { state: "scanning" as const };
};

const fakeApi = (handlers: Record<string, (body: unknown) => unknown>) => {
  const calls: { path: string; body: unknown }[] = [];
  const api: ApiClient = {
    post: async (path, body) => {
      calls.push({ path, body });
      const h = handlers[path];
      if (!h) throw new Error(`unexpected ${path}`);
      return h(body) as never;
    },
  };
  return { api, calls };
};

describe("PairingScanner", () => {
  it("decodes camera frames into a verified payload with the fingerprint to show", async () => {
    const agent = await generateDeviceKeys();
    const r = await scan(await agentGlyph(agent));
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.display).toEqual({
      label: "Escritorio",
      fingerprint: await fingerprint(agent.sign.publicKey),
      agentDeviceId: agent.deviceId,
      expiresInMs: 4 * 60_000 - 1000,
    });
    expect(await agentFromGlyph(r.glyph)).toEqual({
      deviceId: agent.deviceId,
      pubBox: (await publicKeys(agent)).pubBox,
    });
  });

  it("rejects an expired code, another purpose, and a tampered payload", async () => {
    const agent = await generateDeviceKeys();
    expect(await scan(await agentGlyph(agent), NOW + 5 * 60_000)).toMatchObject({
      state: "rejected",
      reason: "expired",
    });
    expect(await scan(await agentGlyph(agent, { purpose: "room_invite" }))).toMatchObject({ reason: "wrong_purpose" });
    const g = await agentGlyph(agent);
    const evil = await generateDeviceKeys();
    const forged = { ...g, body: { ...g.body, issuerPubSign: await toB64url(evil.sign.publicKey) } };
    expect(await scan(forged)).toMatchObject({ state: "rejected", reason: "bad_signature" });
  });
});

describe("short-code fallback and claim", () => {
  it("resolves the typed code to the same checks, then signs a claim bound to the fingerprint", async () => {
    const agent = await generateDeviceKeys();
    const phone = await generateDeviceKeys();
    const g = await agentGlyph(agent);
    const { api, calls } = fakeApi({ "/v1/pairing/resolve": () => ({ glyph: g }) });
    const r = await resolveShortCode(api, "abcd-efgh", NOW + 1000);
    expect(calls[0]).toEqual({ path: "/v1/pairing/resolve", body: { shortCode: "abcd-efgh" } });
    expect(r.state).toBe("ready");

    const req = await buildPairingClaim(phone, { owner: "u1", glyph: g, now: NOW + 2000 });
    expect(ClaimPairingRequest.safeParse(req).success).toBe(true);
    expect(req.claim.body).toMatchObject({
      owner: "u1",
      codeId: "code_abcdefgh",
      agentDeviceId: agent.deviceId,
      agentFingerprint: await fingerprint(agent.sign.publicKey),
      claimerDeviceId: phone.deviceId,
    });
    expect(
      (await verifyEnvelope(req.claim, "chalito.pairing-claim.v1", new Map([[phone.deviceId, phone.sign.publicKey]])))
        .ok,
    ).toBe(true);
  });
});

describe("endorse a new browser, revoke a device", () => {
  it("endorses exactly the keys the new browser registered", async () => {
    const phone = await generateDeviceKeys();
    const browser = await generateDeviceKeys();
    const reg = await signDeviceRegistration(browser, {
      owner: "u1",
      kind: "web",
      platform: "web",
      name: "Firefox",
      now: NOW,
    });
    const req = await buildEndorsedEnrolment(phone, { uid: "u1", registration: reg, now: NOW });
    expect(req.endorsement.body).toMatchObject({
      newDeviceId: browser.deviceId,
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
    });
    await expect(buildEndorsedEnrolment(phone, { uid: "u2", registration: reg, now: NOW })).rejects.toThrow(
      /another account/,
    );
    const spoof = { ...reg, body: { ...reg.body, deviceId: phone.deviceId } };
    await expect(buildEndorsedEnrolment(phone, { uid: "u1", registration: spoof, now: NOW })).rejects.toThrow(
      /doesn't match/,
    );
  });

  it("revokes in the directory and signs a revokeClient for every agent", async () => {
    const phone = await generateDeviceKeys();
    const { api, calls } = fakeApi({ "/v1/devices/revoke": () => ({}) });
    const cmds = await revokeDevice(api, phone, {
      uid: "u1",
      deviceId: "dev_lostphone_xxxxxxxxxx",
      agentDeviceIds: ["dev_a", "dev_b"],
      now: NOW,
    });
    expect(calls).toEqual([{ path: "/v1/devices/revoke", body: { deviceId: "dev_lostphone_xxxxxxxxxx" } }]);
    expect(cmds.map((c) => [c.body.targetDeviceId, c.body.payload])).toEqual([
      ["dev_a", { type: "device.revokeClient", clientDeviceId: "dev_lostphone_xxxxxxxxxx" }],
      ["dev_b", { type: "device.revokeClient", clientDeviceId: "dev_lostphone_xxxxxxxxxx" }],
    ]);
    for (const c of cmds) expect(SignedCommand.safeParse(c).success).toBe(true);
  });
});
