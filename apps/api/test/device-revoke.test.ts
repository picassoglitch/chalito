/** POST /v1/devices/revoke: a not_found revoke stops there (no disable, no audit). */
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";

const setup = async (result: "not_found" | "already_revoked" | "revoked") => {
  // Self-contained (no shared fixtures) so this file also runs on main.
  const o = "owner-revoke-test";
  const phone = { owner: o, deviceId: "dev_phone_revoke_test", role: "client", revoked: false };
  const disableDevice = vi.fn(async () => undefined);
  const audit = new MemoryAudit();
  const repo = {
    getDevice: async (a: string, id: string) => (a === o && id === phone.deviceId ? phone : null),
    revokeDevice: async () => result,
  } as unknown as ApiRepo;
  const identity = {
    verify: async () => ({ uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId }),
    disableDevice,
  } as unknown as IdentityIssuer;
  const app = createApp({
    repo,
    identity,
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: Date.now,
  });
  const res = await app.request("/v1/devices/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ deviceId: "dev_unknown_device" }),
  });
  return { status: res.status, json: await res.json(), disableDevice, audit };
};

describe("POST /v1/devices/revoke", () => {
  it("not_found: 404, and it never disables anything or writes an audit entry", async () => {
    const r = await setup("not_found");
    expect(r).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(r.disableDevice).not.toHaveBeenCalled();
    expect(r.audit.events).toEqual([]);
  });

  it("already revoked: ok without disabling again", async () => {
    const r = await setup("already_revoked");
    expect(r).toMatchObject({ status: 200, json: { ok: true, alreadyRevoked: true } });
    expect(r.disableDevice).not.toHaveBeenCalled();
  });

  it("revoked: disables the device's credential and audits it", async () => {
    const r = await setup("revoked");
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(r.disableDevice).toHaveBeenCalledWith("dev_unknown_device");
    expect(r.audit.events.map((e) => e.action)).toEqual(["device.revoked"]);
  });
});
