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

  it("reset: revokes every active device of the owner (clients and agents), only theirs, once", async () => {
    const o = `rs-${randomUUID()}`;
    const other = `rs-${randomUUID()}`;
    for (const x of [o, other]) {
      await admin`insert into chalito.tenants (id) values (${x})`;
      await admin`insert into chalito.users (id, tenant_id) values (${x}, ${x})`;
    }
    const id = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;
    const [c1, a1, gone, theirs] = [id("c1"), id("a1"), id("gone"), id("theirs")];
    for (const [owner, d, r, revoked] of [
      [o, c1, "client", false],
      [o, a1, "agent", false],
      [o, gone, "client", true],
      [other, theirs, "client", false],
    ] as const)
      await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
                  values (${owner}, ${d}, ${r}, ${r === "agent" ? "desktop" : "phone"}, 'linux', 'd', 'p', 'p', 'f', 'pairing', ${randomUUID()}, ${revoked})`;
    expect(await repo.revokeAllDevices(o, Date.now(), "reset")).toEqual([a1, c1].sort());
    expect(await repo.revokeAllDevices(o, Date.now(), "reset")).toEqual([]);
    const [mine] = await admin`select count(*)::int as n from chalito.devices where owner = ${o} and revoked = false`;
    expect(mine!.n).toBe(0);
    const [row] = await admin`select revoked_by from chalito.devices where device_id = ${c1}`;
    expect(row!.revoked_by).toBe("reset");
    const [still] = await admin`select revoked from chalito.devices where device_id = ${theirs}`;
    expect(still!.revoked).toBe(false);
  });
}
