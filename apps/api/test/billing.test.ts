import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubClient } from "@chalito/billing";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";

/** The hub's balance route, mocked at the HTTP layer; the api's own HubClient calls it. */
const hub: { mode: "ok" | "down" | "garbage"; calls: string[] } = { mode: "ok", calls: [] };
const BALANCE = {
  remaining: 4_200_000,
  unlimited: false,
  monthlyAllocation: 5_000_000,
  bonus: 100_000,
  monthlyUsed: 900_000,
  reserved: 50_000,
  periodStart: "2026-10-01T00:00:00.000Z",
};
const server = setupServer(
  http.get("https://www.chalyb.com/api/engines/chalito/usage/balance", ({ request }) => {
    hub.calls.push(new URL(request.url).searchParams.get("external_user_id")!);
    if (hub.mode === "down") return new HttpResponse(null, { status: 503 });
    if (hub.mode === "garbage") return HttpResponse.json({ ok: true, balance: { remaining: "lots" } });
    return HttpResponse.json({ ok: true, balance: { ...BALANCE, priceMxn: 99 } });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  hub.mode = "ok";
  hub.calls.length = 0;
});

const setup = () => {
  let now = 1_790_000_000_000;
  const devices = new Map([
    ["dev_phone", { deviceId: "dev_phone", role: "client", revoked: false } as DeviceDoc],
    ["dev_agent", { deviceId: "dev_agent", role: "agent", revoked: false } as DeviceDoc],
  ]);
  // Bearer "<role>:<deviceId>[:<owner>]".
  const identity = {
    verify: async (token: string) => {
      const [role, deviceId, owner = "hub-user-1"] = token.split(":");
      return { uid: deviceId ? `d_${deviceId}` : owner, role, owner, ...(deviceId ? { deviceId } : {}) };
    },
  } as unknown as IdentityIssuer;
  const app = createApp({
    repo: { getDevice: async (_o: string, id: string) => devices.get(id) ?? null } as unknown as ApiRepo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => now,
    billing: { hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }) },
  });
  const get = async (token = "client:dev_phone") => {
    const res = await app.request("/v1/billing/balance", { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
  };
  return { get, advance: (ms: number) => void (now += ms) };
};

describe("GET /v1/billing/balance", () => {
  it("returns the owner's hub balance in tokens only", async () => {
    const { get } = setup();
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.json).toEqual(BALANCE);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(hub.calls).toEqual(["hub-user-1"]);
  });

  it("works for the person's session too, for their own owner", async () => {
    const { get } = setup();
    expect((await get("user::hub-user-2")).status).toBe(200);
    expect(hub.calls).toEqual(["hub-user-2"]);
  });

  it("agents and anonymous callers get nothing", async () => {
    const { get } = setup();
    expect((await get("agent:dev_agent")).status).toBe(403);
    expect(hub.calls).toEqual([]);
  });

  it("caches each owner's balance for ~30 s", async () => {
    const { get, advance } = setup();
    await get();
    await get();
    await get("client:dev_phone:hub-user-3");
    expect(hub.calls).toEqual(["hub-user-1", "hub-user-3"]);
    advance(29_000);
    await get();
    expect(hub.calls).toHaveLength(2);
    advance(2_000);
    await get();
    expect(hub.calls).toEqual(["hub-user-1", "hub-user-3", "hub-user-1"]);
  });

  it("a hub failure or a malformed answer is 503 hub_unavailable, and isn't cached", async () => {
    const { get } = setup();
    hub.mode = "down";
    expect(await get()).toMatchObject({ status: 503, json: { error: "hub_unavailable" } });
    hub.mode = "garbage";
    expect(await get()).toMatchObject({ status: 503, json: { error: "hub_unavailable" } });
    hub.mode = "ok";
    expect((await get()).status).toBe(200);
    expect(hub.calls).toHaveLength(3);
  });
});
