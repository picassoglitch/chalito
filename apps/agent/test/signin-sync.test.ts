import { describe, expect, it, vi } from "vitest";
import {
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { syncRevocations, syncSignIns } from "../src/endorsement-sync.js";
import { MemoryStore } from "../src/store.js";

const NOW = 1_790_000_000_000;
const SELF = "agent_self";

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
type Device = Awaited<ReturnType<typeof device>>;

const binding = (d: Device, signer: Device = d) =>
  signEnvelope(
    "chalito.webauthn-binding.v1",
    {
      v: 1 as const,
      deviceId: d.deviceId,
      credentialId: "cGFzc2tleS1pZC1vZi10aGUtcGhvbmU",
      publicKey: "cHViLWtleQ",
      rpId: "chalito.chalyb.com",
      issuedAt: NOW,
    },
    d.deviceId,
    signer.sign.secretKey,
  );

const row = (d: Device, webauthnBinding: unknown = null) => ({
  deviceId: d.deviceId,
  pubSign: d.pubSign,
  pubBox: d.pubBox,
  webauthnBinding,
});

const setup = () => {
  const list = new TrustedClientList(SELF);
  const store = new MemoryStore();
  const saveTrust = vi.fn(async () => undefined);
  const onAdded = vi.fn();
  const run = () => syncSignIns({ store, trust: () => list, saveTrust, now: () => NOW, onAdded });
  return { list, store, saveTrust, onAdded, run };
};

describe("syncSignIns (sign-in alone)", () => {
  it("trusts a client the person signed in on, with no endorsement or local confirmation", async () => {
    const s = setup();
    const browser = await device();
    s.store.pushSignIn(row(browser));
    expect(await s.run()).toEqual([browser.deviceId]);
    expect(s.list.has(browser.deviceId)).toBe(true);
    expect(s.list.toJSON()[0]).toMatchObject({ deviceId: browser.deviceId, via: "sign_in", addedAt: NOW });
    expect(s.list.recipients()).toEqual({ [browser.deviceId]: browser.pubBox });
    expect(s.onAdded).toHaveBeenCalledWith(browser.deviceId);
    expect(s.saveTrust).toHaveBeenCalledTimes(1);
    // Its signatures now verify here.
    const signed = await signEnvelope("chalito.decision.v1", { x: 1 }, browser.deviceId, browser.sign.secretKey);
    expect((await s.list.verifySigned(signed, "chalito.decision.v1")).ok).toBe(true);
  });

  it("is idempotent and saves nothing when nothing changed", async () => {
    const s = setup();
    s.store.pushSignIn(row(await device()));
    await s.run();
    expect(await s.run()).toEqual([]);
    expect(s.saveTrust).toHaveBeenCalledTimes(1);
  });

  it("records its passkey binding, also when it registers one later", async () => {
    const s = setup();
    const a = await device();
    const b = await device();
    s.store.pushSignIn(row(a, await binding(a)));
    s.store.pushSignIn(row(b));
    await s.run();
    expect(s.list.webauthnFor(a.deviceId)?.rpId).toBe("chalito.chalyb.com");
    expect(s.list.webauthnFor(b.deviceId)).toBeUndefined();
    s.store.signIns[1] = row(b, await binding(b));
    await s.run();
    expect(s.list.webauthnFor(b.deviceId)?.rpId).toBe("chalito.chalyb.com");
  });

  it("ignores a binding signed by another key, a key that doesn't match the id, and a missing box key", async () => {
    const s = setup();
    const a = await device();
    const forger = await device();
    s.store.pushSignIn(row(a, await binding(a, forger)));
    const liar = await device();
    s.store.pushSignIn({ ...row(liar), pubSign: forger.pubSign });
    const noBox = await device();
    s.store.pushSignIn({ ...row(noBox), pubBox: "" });
    expect(await s.run()).toEqual([a.deviceId]);
    expect(s.list.webauthnFor(a.deviceId)).toBeUndefined();
  });

  it("never brings back a client removed here, and a revoked one is dropped first", async () => {
    const s = setup();
    const a = await device();
    s.store.pushSignIn(row(a));
    await s.run();
    s.store.revokeInDirectory(a.deviceId);
    await syncRevocations({ store: s.store, trust: () => s.list, saveTrust: s.saveTrust, onRevoked: () => undefined });
    expect(s.list.has(a.deviceId)).toBe(false);
    // Even if the directory listed it as active again, the tombstone holds.
    s.store.revokedDevices.delete(a.deviceId);
    expect(await s.run()).toEqual([]);
    expect(s.list.isRemoved(a.deviceId)).toBe(true);
  });
});
