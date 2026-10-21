import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { loadPlans } from "@chalito/config";
import { hubEntitlements } from "../src/entitlements.js";

/** hubEntitlements over chalito.users as CHALITO_DB_ROLE (chalito_server) on DATABASE_URL. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE ?? "chalito_server";

describe.skipIf(!url)("hubEntitlements", () => {
  const admin = postgres(url ?? "postgres://unused", { max: 2, onnotice: () => {} });
  const sql = postgres(url ?? "postgres://unused", { max: 2, onnotice: () => {}, connection: { role } });
  afterAll(async () => {
    await Promise.all([admin.end(), sql.end()]);
  });

  const entitlementsFor = async (tier: string | null) => {
    const owner = `ent-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${owner})`;
    await admin`insert into chalito.users (id, tenant_id, tier) values (${owner}, ${owner}, ${tier})`;
    const hub = { balance: async () => ({ remaining: 1000, unlimited: false }) };
    return hubEntitlements({ sql, hub: hub as never, plans: loadPlans(), comped: () => false, now: () => Date.now() })(
      owner,
    );
  };

  it.each([
    ["free", "free", null],
    ["pro", "pro", "standard"],
    ["vip", "vip", "plus"],
  ])("maps the stored hub tier %j to its access tier", async (tier, hubTier, accessTier) => {
    expect(await entitlementsFor(tier)).toMatchObject({ hubTier, accessTier });
  });

  it.each([
    ["PRO", "pro", "standard"],
    [" Pro ", "pro", "standard"],
    ["VIP", "vip", "plus"],
  ])(
    "reads users.tier %j case-insensitively, like the notifier's caps (audit 2026-10-08)",
    async (tier, hubTier, accessTier) => {
      expect(await entitlementsFor(tier)).toMatchObject({ source: "hub_tier", hubTier, accessTier });
    },
  );

  it.each([null, "gold", "  "])("fails closed on a tier it doesn't know (%j)", async (tier) => {
    expect(await entitlementsFor(tier)).toMatchObject({ hubTier: null, accessTier: null });
  });
});
