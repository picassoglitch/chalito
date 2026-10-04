import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresRepo } from "../src/postgres/repo.js";
import { chalitoAuthUserId } from "../src/supabase/identity.js";

/** PostgresRepo.revokeOtherClients / activeAgents / queueCommand, as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("revoke-all repo", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 2, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const repo = new PostgresRepo(sql, { authUserId: chalitoAuthUserId });

  it("revokes every other active client in one go, lists agents, queues commands once", async () => {
    const o = `ra-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${o})`;
    await admin`insert into chalito.users (id, tenant_id) values (${o}, ${o})`;
    const id = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;
    const [keep, c1, c2, a1, old] = [id("keep"), id("c1"), id("c2"), id("a1"), id("old")];
    for (const [d, r, revoked] of [
      [keep, "client", false],
      [c1, "client", false],
      [c2, "client", false],
      [a1, "agent", false],
      [old, "client", true],
    ] as const)
      await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
                  values (${o}, ${d}, ${r}, ${r === "agent" ? "desktop" : "phone"}, 'linux', 'd', 'p', 'p', 'f', 'pairing', ${randomUUID()}, ${revoked})`;
    expect(await repo.revokeOtherClients(o, keep, Date.now())).toEqual([c1, c2].sort());
    expect(await repo.revokeOtherClients(o, keep, Date.now())).toEqual([]);
    const rows =
      await admin`select device_id, revoked, revoked_by from chalito.devices where owner = ${o} order by device_id`;
    expect(
      rows
        .filter((r) => r.revoked)
        .map((r) => r.device_id)
        .sort(),
    ).toEqual([c1, c2, old].sort());
    expect(rows.find((r) => r.device_id === c1)!.revoked_by).toBe(keep);
    expect(await repo.activeAgents(o)).toEqual([a1]);
    const cmd = {
      targetDeviceId: a1,
      id: id("cmd"),
      env: { ctx: "chalito.command.v1" },
      fromDeviceId: keep,
      expiresAt: Date.now() + 60_000,
    };
    expect(await repo.queueCommand(o, cmd)).toBe(true);
    expect(await repo.queueCommand(o, cmd)).toBe(false);
  });
}
