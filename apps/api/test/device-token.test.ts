import { describe, expect, it } from "vitest";
import { deriveDeviceId, generateSigningKeyPair, randomNonce, signEnvelope, toB64url } from "@chalito/crypto";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";
import { device } from "./contract/fixtures.js";

/** /v1/devices/token with in-memory fakes: only the methods the route touches. */
const setup = async (role: DeviceDoc["role"], withRelease = true) => {
  const sign = await generateSigningKeyPair();
  const owner = "hub-user-1";
  // The fixture's keys are its own; give the device these signing keys and their derived id.
  const d = {
    ...(await device(owner, role)),
    pubSign: await toB64url(sign.publicKey),
    deviceId: await deriveDeviceId(sign.publicKey),
  };
  const watches = new Map([[d.deviceId, ["code_a"]]]);
  const released: string[] = [];
  const repo = {
    getDevice: async (o: string, id: string) => (o === owner && id === d.deviceId ? d : null),
    claimDeviceNonce: async () => true,
    touchDevice: async () => undefined,
    releasePairingWatches: async (_o: string, id: string) => {
      const w = watches.get(id) ?? [];
      watches.delete(id);
      return w;
    },
  } as unknown as ApiRepo;
  const identity = {
    mintDevice: async (_o: string, id: string) => `hash-for-${id}`,
    ...(withRelease ? { releasePairingWatch: async (codeId: string) => void released.push(codeId) } : {}),
  } as unknown as IdentityIssuer;
  const app = createApp({
    repo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: Date.now,
  });
  const token = async () => {
    const body = { v: 1, owner, deviceId: d.deviceId, nonce: await randomNonce(), issuedAt: Date.now() };
    const env = await signEnvelope("chalito.refresh-challenge.v1", body, d.deviceId, sign.secretKey);
    const res = await app.request("/v1/devices/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { d, released, token };
};

describe("POST /v1/devices/token", () => {
  it("returns the device credential and releases the agent's pairing watcher once", async () => {
    const { d, released, token } = await setup("agent");
    expect(await token()).toEqual({
      status: 200,
      json: { customToken: `hash-for-${d.deviceId}`, deviceId: d.deviceId },
    });
    expect(released).toEqual(["code_a"]);
    await token();
    expect(released).toEqual(["code_a"]);
  });

  it("clients and issuers without per-code watchers release nothing", async () => {
    const client = await setup("client");
    expect((await client.token()).status).toBe(200);
    expect(client.released).toEqual([]);
    const firebaseLike = await setup("agent", false);
    expect((await firebaseLike.token()).status).toBe(200);
  });
});
