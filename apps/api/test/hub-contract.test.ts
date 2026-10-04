import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { verifySsoToken } from "../src/hub/sso.js";
import type { ApiRepo } from "../src/repo.js";

/**
 * The hub → Chalito direction, as the hub's engine factory actually calls it. Copied from
 * picassoglitch/chalyb src/lib/engines/integrations/factory.ts @ main 3f27ef3
 * (3f27ef391607ea8f8772df1a00da72a18eb54443): provisioning :168-200, status :113-140, the launch
 * token :85-87 and :277-292. Update with the file:line and sha when the factory changes.
 */
const ADMIN = "chalito-admin-token";
const SSO = "chalito-sso-secret";
const NOW = 1_790_000_000_000;

const app = () => {
  const tenants = new Map<string, string>();
  const repo = {
    createTenant: async (t: { tenantId: string }) =>
      tenants.has(t.tenantId) ? "exists" : (tenants.set(t.tenantId, "active"), "created"),
    setTenantStatus: async (id: string, status: string) => (tenants.has(id) ? (tenants.set(id, status), true) : false),
  } as unknown as ApiRepo;
  const a = createApp({
    repo,
    identity: { verify: async () => Promise.reject(new Error("no")) } as never,
    audit: new MemoryAudit(),
    config: { ssoSecret: SSO, adminToken: ADMIN, recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => NOW,
  } as unknown as Deps);
  return { a, tenants };
};

/** factory.ts:168-180: the hub's POST {admin_api_base}/tenants. */
const provision = (
  a: ReturnType<typeof app>["a"],
  user: { id: string; email: string; fullName: string | null; tier: string },
) =>
  a.request("/tenants", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      external_user_id: user.id,
      email: user.email,
      display_name: user.fullName ?? user.email.split("@")[0],
      tier: user.tier.toLowerCase(),
    }),
  });

describe("hub → Chalito: provisioning and status (factory.ts @ main 3f27ef3)", () => {
  it("POST /tenants answers what the factory requires: 200/201 or 409, each with tenant_id and api_token", async () => {
    const { a } = app();
    const first = await provision(a, { id: "hub-user-1", email: "ana@example.mx", fullName: null, tier: "PRO" });
    expect([200, 201]).toContain(first.status);
    const body = (await first.json()) as { tenant_id?: string; api_token?: string };
    expect(body.tenant_id && body.api_token).toBeTruthy();
    // factory.ts:191-200: 409 counts as success, but only with both fields.
    const again = await provision(a, { id: "hub-user-1", email: "ana@example.mx", fullName: "Ana", tier: "PRO" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: "duplicate",
      tenant_id: body.tenant_id,
      api_token: body.api_token,
    });
  });

  it("the status call uses the external user id in the path and accepts 200/204 (factory.ts:113-128)", async () => {
    const { a, tenants } = app();
    await provision(a, { id: "hub-user-2", email: "b@example.mx", fullName: null, tier: "FREE" });
    for (const status of ["paused", "active"] as const) {
      const res = await a.request(`/tenants/${encodeURIComponent("hub-user-2")}/status`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      expect([200, 204]).toContain(res.status);
      expect(tenants.get("hub-user-2")).toBe(status);
    }
  });

  it("a wrong bearer is 401/403, as the factory expects (factory.ts:129-131)", async () => {
    const { a } = app();
    const res = await a.request("/tenants", {
      method: "POST",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: "{}",
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("hub → Chalito: the launch token (factory.ts:85-87, :277-282 @ main 3f27ef3)", () => {
  it("verifies a token signed exactly like signLaunchToken, with the factory's fields", () => {
    const payload = {
      user_id: "hub-user-1",
      email: "ana@example.mx",
      tenant_id: "hub-user-1",
      tier: "pro",
      exp: Math.floor(NOW / 1000) + 300,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `${body}.${createHmac("sha256", SSO).update(body).digest("base64url")}`;
    const r = verifySsoToken(token, SSO, NOW);
    expect(r.ok && r.payload).toEqual(payload);
  });
});
