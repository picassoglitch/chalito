import { describe, expect, it } from "vitest";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo } from "../src/repo.js";

/**
 * "Empezar de cero" (hub → Chalito): once the hub has checked the person's email code, it asks
 * Chalito to retire every device of the account so this browser can activate as the first one.
 */
const ADMIN = "chalito-admin-token";
const NOW = 1_790_000_000_000;

const dev = (owner: string, deviceId: string, role: "client" | "agent", revoked = false) =>
  ({ owner, deviceId, role, revoked }) as unknown as DeviceDoc;

const setup = (devices: DeviceDoc[], banOk = true) => {
  const banned: string[] = [];
  const linksBy: string[] = [];
  const audit = new MemoryAudit();
  const repo: Partial<ApiRepo> = {
    revokeAllDevices: async (o, _at, _by) => {
      const hit = devices.filter((d) => d.owner === o && !d.revoked);
      for (const d of hit) (d as { revoked: boolean }).revoked = true;
      return hit.map((d) => d.deviceId).sort();
    },
    revokeAgentLinks: async (_o, by) => {
      linksBy.push(by);
      return 0;
    },
  };
  const app = createApp({
    repo: repo as ApiRepo,
    identity: {
      verify: async () => Promise.reject(new Error("no")),
      disableDevice: async (id: string) => (banned.push(id), banOk),
    } as never,
    audit,
    config: { ssoSecret: "s", adminToken: ADMIN, recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => NOW,
  } as unknown as Deps);
  const reset = (owner: string, token = ADMIN) =>
    app.request(`/tenants/${owner}/reset-devices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  return { reset, banned, linksBy, audit, devices };
};

describe("POST /tenants/:id/reset-devices", () => {
  it("revokes every active device of the account (clients and computers) and bans their logins", async () => {
    const s = setup([
      dev("ana", "c1", "client"),
      dev("ana", "a1", "agent"),
      dev("ana", "old", "client", true),
      dev("bob", "b1", "client"),
    ]);
    const r = await s.reset("ana");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revoked: 2 });
    expect(s.banned.sort()).toEqual(["a1", "c1"]);
    expect(s.devices.find((d) => d.deviceId === "b1")!.revoked).toBe(false);
    expect(s.linksBy).toEqual(["reset"]);
    const actions = s.audit.events.map((e) => e.action);
    expect(actions).toContain("devices.reset");
    expect(actions.filter((a) => a === "device.revoked")).toHaveLength(2);
  });

  it("answers 200 with 0 when there is nothing to revoke (a retry is harmless)", async () => {
    const s = setup([dev("ana", "c1", "client", true)]);
    const r = await s.reset("ana");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revoked: 0 });
  });

  it("needs the hub's admin token", async () => {
    const s = setup([dev("ana", "c1", "client")]);
    expect((await s.reset("ana", "wrong")).status).toBe(401);
    expect(s.devices[0]!.revoked).toBe(false);
  });

  it("reports ban failures without undoing the revocation", async () => {
    const s = setup([dev("ana", "c1", "client")], false);
    const r = await s.reset("ana");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revoked: 1, banFailed: ["c1"] });
    expect(s.devices[0]!.revoked).toBe(true);
  });
});
