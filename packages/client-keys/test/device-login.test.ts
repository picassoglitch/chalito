import { describe, expect, it } from "vitest";
import { DeviceClientKeys, deviceLogin, generateDeviceKeys, type ApiClient } from "../src/index.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";
const NOW = 1_780_000_000_000;

const api = (reply: (body: unknown) => unknown): ApiClient & { calls: [string, unknown][] } => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    post: async <T>(path: string, body: unknown) => {
      calls.push([path, body]);
      return reply(body) as T;
    },
  };
};

describe("deviceLogin (signed refresh challenge)", () => {
  it("signs a fresh challenge as this device and returns its magic-link hash", async () => {
    const keys = await DeviceClientKeys.create(await generateDeviceKeys());
    const a = api(() => ({ customToken: "dev-hash", deviceId: keys.deviceId }));
    const login = deviceLogin(a, keys, OWNER, () => NOW);
    expect(await login()).toBe("dev-hash");
    await login();
    const [path, first] = a.calls[0]! as [
      string,
      { ctx: string; signerDeviceId: string; body: Record<string, unknown> },
    ];
    const second = a.calls[1]![1] as { body: { nonce: string } };
    expect(path).toBe("/v1/devices/token");
    expect(first.ctx).toBe("chalito.refresh-challenge.v1");
    expect(first.signerDeviceId).toBe(keys.deviceId);
    expect(first.body).toMatchObject({ v: 1, owner: OWNER, deviceId: keys.deviceId, issuedAt: NOW });
    expect(first.body.nonce).not.toBe(second.body.nonce);
  });

  it("refuses a token minted for another device", async () => {
    const keys = await DeviceClientKeys.create(await generateDeviceKeys());
    const other = (await generateDeviceKeys()).deviceId;
    await expect(
      deviceLogin(
        api(() => ({ customToken: "h", deviceId: other })),
        keys,
        OWNER,
      )(),
    ).rejects.toThrow(/another device/);
  });
});
