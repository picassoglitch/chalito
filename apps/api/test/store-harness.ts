/** Store test harness: the Chalyb hub mocked at the HTTP layer, the store over a memory repo. */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { HubClient } from "@chalito/billing";
import { loadCatalog } from "@chalito/config";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";
import { MemoryStoreRepo } from "../src/store/repo.js";

export const RID = "44444444-4444-4444-8444-444444444444";
export const hubCalls: { path: string; body: Record<string, unknown> }[] = [];
export const hubState: { mode: "ok" | "no_tokens" | "down"; remaining: number; settleDown: boolean } = {
  mode: "ok",
  remaining: 5_000_000,
  settleDown: false,
};
const server = setupServer(
  http.post("https://www.chalyb.com/api/engines/chalito/usage/admit", async ({ request }) => {
    hubCalls.push({ path: "admit", body: (await request.json()) as Record<string, unknown> });
    if (hubState.mode === "down") return new HttpResponse(null, { status: 503 });
    return HttpResponse.json(
      hubState.mode === "ok"
        ? {
            ok: true,
            allowed: true,
            reservation_id: RID,
            lane: "standard",
            boost_fee_tokens: 0,
            limits: {},
            balance: {
              remaining: hubState.remaining,
              reserved: 0,
              unlimited: false,
              monthlyAllocation: 5_000_000,
              bonus: 0,
              monthlyUsed: 0,
              periodStart: "2026-10-01T00:00:00.000Z",
            },
          }
        : { ok: true, allowed: false, reason: "no_tokens" },
    );
  }),
  http.post("https://www.chalyb.com/api/engines/chalito/usage/settle", async ({ request }) => {
    hubCalls.push({ path: "settle", body: (await request.json()) as Record<string, unknown> });
    // A network failure (fetch rejects), not an HTTP status.
    if (hubState.settleDown) return HttpResponse.error();
    return HttpResponse.json({ ok: true });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  hubCalls.length = 0;
  hubState.mode = "ok";
  hubState.remaining = 5_000_000;
  hubState.settleDown = false;
});

export const CID = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const PID = "pur_0123456789abcdef";
export const catalog = loadCatalog();

export const storeSetup = () => {
  const store = new MemoryStoreRepo();
  store.companions.set(`hub-user-1/${CID}`, {});
  const devices = new Map([
    ["dev_phone", { deviceId: "dev_phone", role: "client", revoked: false } as DeviceDoc],
    ["dev_agent", { deviceId: "dev_agent", role: "agent", revoked: false } as DeviceDoc],
  ]);
  // Bearer "<role>:<deviceId>[:<owner>]" in these tests.
  const identity = {
    verify: async (token: string) => {
      const [role, deviceId, owner = "hub-user-1"] = token.split(":");
      return { uid: `d_${deviceId}`, role, owner, ...(deviceId ? { deviceId } : {}) };
    },
  } as unknown as IdentityIssuer;
  const repo = { getDevice: async (_o: string, id: string) => devices.get(id) ?? null } as unknown as ApiRepo;
  const audit = new MemoryAudit();
  const app = createApp({
    repo,
    identity,
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => 1_790_000_000_000,
    store: {
      repo: store,
      catalog,
      hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }),
    },
  });
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token = "client:dev_phone") => {
    const res = await app.request(`/v1/store${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { call, store, audit };
};
