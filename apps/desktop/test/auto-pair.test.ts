// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ApiError,
  DeviceClientKeys,
  deviceFingerprint,
  generateDeviceKeys,
  publicKeys,
  type ApiClient,
} from "@chalito/client-keys";
import { fingerprint, randomNonce, verifyEnvelope } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import { approvedByThisPanel, claimOwnComputer } from "../src/lib/auto-pair.js";
import type { PendingPairing } from "../src/lib/ipc.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";

const setup = async () => {
  const now = Date.now();
  const agent = await generateDeviceKeys();
  const pub = await publicKeys(agent);
  const glyph = await signGlyph(
    {
      v: 1,
      purpose: "pair_device",
      codeId: "code_abcdefghijklmnopqrstuv",
      issuerPubSign: pub.pubSign,
      issuerPubBox: pub.pubBox,
      label: "Escritorio",
      issuedAt: now,
      expiresAt: now + 4 * 60_000,
      nonce: (await randomNonce()).slice(0, 22),
    },
    agent.sign.secretKey,
  );
  const fp = await fingerprint(agent.sign.publicKey);
  const pending: PendingPairing = {
    pairingId: "p1",
    state: "waiting",
    computer: {
      shortCode: "7K3M-QX9P",
      fingerprint: fp,
      label: "Escritorio",
      approveUrl: "https://www.chalyb.com/app/chalito/computadoras/aprobar#c=code_abcdefghijklmnopqrstuv",
      expiresAt: now + 4 * 60_000,
      glyph,
    },
    claimer: null,
    replacePhrase: null,
    error: null,
  };
  const panelKeys = await generateDeviceKeys();
  const panel = await DeviceClientKeys.create(panelKeys);
  const posts: [string, unknown][] = [];
  const api = (fail?: Error): ApiClient => ({
    post: async <T>(path: string, body: unknown) => {
      posts.push([path, body]);
      if (fail) throw fail;
      return { ok: true } as T;
    },
  });
  return { now, agent, fp, pending, panel, panelKeys, posts, api };
};

describe("the signed-in panel connects its own computer", () => {
  it("claims the code with the short code the agent gave it, signed by this panel, then trusts the computer", async () => {
    const s = await setup();
    expect(await claimOwnComputer(s.api(), s.panel, s.pending, { owner: OWNER, now: s.now })).toEqual({ ok: true });
    expect(s.posts).toHaveLength(1);
    const [path, body] = s.posts[0]! as [string, { claim: Parameters<typeof verifyEnvelope>[0]; shortCode: string }];
    expect(path).toBe("/v1/pairing/claim");
    expect(body.shortCode).toBe("7K3M-QX9P");
    expect(body.claim.body).toMatchObject({
      owner: OWNER,
      codeId: "code_abcdefghijklmnopqrstuv",
      agentDeviceId: s.agent.deviceId,
      agentFingerprint: s.fp,
      claimerDeviceId: s.panel.deviceId,
    });
    const ok = await verifyEnvelope(
      body.claim,
      "chalito.pairing-claim.v1",
      new Map([[s.panel.deviceId, s.panelKeys.sign.publicKey]]),
    );
    expect(ok.ok).toBe(true);
    expect(s.panel.trustedAgentBoxKey(s.agent.deviceId)).toBe((await publicKeys(s.agent)).pubBox);
  });

  it("refuses a glyph that isn't the computer the agent named (nothing posted)", async () => {
    const s = await setup();
    const wrong = { ...s.pending, computer: { ...s.pending.computer!, fingerprint: "00 00 00" } };
    expect(await claimOwnComputer(s.api(), s.panel, wrong, { owner: OWNER, now: s.now })).toEqual({
      ok: false,
      reason: "fingerprint_mismatch",
    });
    const tampered = { ...s.pending, computer: { ...s.pending.computer!, glyph: { nope: 1 } } };
    expect((await claimOwnComputer(s.api(), s.panel, tampered, { owner: OWNER, now: s.now })).ok).toBe(false);
    expect(s.posts).toEqual([]);
  });

  it("passes the api's refusal on, and trusts nothing", async () => {
    const s = await setup();
    const r = await claimOwnComputer(s.api(new ApiError(403, "device_limit")), s.panel, s.pending, {
      owner: OWNER,
      now: s.now,
    });
    expect(r).toEqual({ ok: false, reason: "device_limit" });
    expect(s.panel.trustedAgentBoxKey(s.agent.deviceId)).toBeNull();
  });

  it("only this panel's own key is confirmed by itself", async () => {
    const s = await setup();
    const own = await deviceFingerprint(s.panelKeys);
    expect(own).toBe(await fingerprint(s.panelKeys.sign.publicKey));
    const claimed = (f: string): PendingPairing => ({
      ...s.pending,
      state: "claimed",
      claimer: { fingerprint: f, passkeyId: null },
    });
    expect(approvedByThisPanel(claimed(own), own)).toBe(true);
    expect(approvedByThisPanel(claimed("99aa"), own)).toBe(false);
    expect(approvedByThisPanel(claimed(own), null)).toBe(false);
    expect(approvedByThisPanel({ ...claimed(own), state: "waiting" }, own)).toBe(false);
  });
});
