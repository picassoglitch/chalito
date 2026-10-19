import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { checkRole, pgOptions } from "@chalito/config";
import { PostgresRepo, chalitoSql } from "../src/postgres/repo.js";

/**
 * Through a transaction-mode pooler (Supavisor :6543 in prod; PgBouncer pool_mode=transaction
 * locally). POOLER_URL: a login whose default role is chalito_server (`alter role … set role
 * chalito_server`); GATEWAY_POOLER_URL: the same for chalito_gateway. Skipped without them.
 */
const url = process.env.POOLER_URL;
const gatewayUrl = process.env.GATEWAY_POOLER_URL;

describe.runIf(url)("transaction pooler", () => {
  const sql = chalitoSql(url!, { role: "chalito_server", max: 20 });
  afterAll(() => sql.end());

  it("acts as chalito_server from the login's default role, and checkRole agrees", async () => {
    await expect(checkRole(sql, "chalito_server")).resolves.toBeUndefined();
    await expect(checkRole(sql, "postgres")).rejects.toThrow("acts as chalito_server, expected postgres");
  });

  it("the old options (startup role, prepared statements) don't survive the pooler", async () => {
    const old = postgres(url!, { max: 2, onnotice: () => {}, connection: { role: "chalito_server" } });
    await expect(old`select 1`).rejects.toThrow();
    await old.end();
  });

  it("many clients, few server connections: the same statements and transactions interleave safely", async () => {
    const repo = new PostgresRepo(sql);
    const owner = crypto.randomUUID();
    const now = Date.now();
    await repo.createTenant({
      tenantId: owner,
      email: `${owner}@pool.test`,
      displayName: "Pool",
      tier: "pro",
      createdAt: now,
    });
    // More concurrent clients than the pooler has server connections, each repeating one statement.
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        i % 2
          ? sql`select current_user as u, ${i}::int as i`.then(([r]) => r)
          : sql.begin(async (tx) => {
              const [r] = await tx`select current_user as u, ${i}::int as i`;
              return r;
            }),
      ),
    );
    expect(results.every((r) => r?.u === "chalito_server")).toBe(true);
    expect(results.map((r) => r?.i)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(
      await repo.createTenant({
        tenantId: owner,
        email: `${owner}@pool.test`,
        displayName: "Pool",
        tier: "pro",
        createdAt: now,
      }),
    ).toBe("exists");
  });

  it("server privileges only: no superuser, no bypassing RLS", async () => {
    const [r] = await sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe.runIf(gatewayUrl)("transaction pooler, gateway login", () => {
  const sql = postgres(gatewayUrl!, pgOptions(gatewayUrl!, { role: "chalito_gateway", max: 5 }));
  afterAll(() => sql.end());

  it("acts as chalito_gateway and can't write", async () => {
    await expect(checkRole(sql, "chalito_gateway")).resolves.toBeUndefined();
    await expect(
      sql`insert into chalito.tenants (id, created_at) values (${crypto.randomUUID()}, now())`,
    ).rejects.toThrow(/permission denied/);
  });
});
