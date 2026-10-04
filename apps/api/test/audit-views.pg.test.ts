import { randomUUID } from "node:crypto";
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresAuditSink } from "../src/postgres/audit.js";

/** chalito.server_audit + the owner-readable audit views (migration 002400), under real RLS. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("audit views", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const server = postgres(url, { max: 2, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await server.end();
    await admin.end();
  });

  /** Runs `fn` as an authenticated hub user (role user) for `owner`, then rolls back. */
  const asUser = async <T>(owner: string, fn: (tx: TransactionSql) => Promise<T>) => {
    let out: T;
    await admin
      .begin(async (tx) => {
        const claims = { role: "authenticated", aud: "authenticated", sub: owner, app_metadata: { provider: "email" } };
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`set local role authenticated`;
        out = await fn(tx);
        throw new Error("rollback");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error && e.message === "rollback")) throw e;
      });
    return out!;
  };

  const setup = async () => {
    const [a, b] = [`aud-${randomUUID()}`, `aud-${randomUUID()}`];
    const dev = { [a]: `ag_${randomUUID().slice(0, 8)}`, [b]: `ag_${randomUUID().slice(0, 8)}` };
    for (const u of [a, b]) {
      await admin`insert into chalito.tenants (id) values (${u})`;
      await admin`insert into chalito.users (id, tenant_id) values (${u}, ${u})`;
      await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
                  values (${u}, ${dev[u]!}, 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', ${randomUUID()})`;
    }
    const sink = new PostgresAuditSink(server);
    await sink.record({ action: "device.revoked", owner: a, actor: "d_phone", target: "agent_1" });
    await sink.record({ action: "store.purchase", owner: a, actor: "d_phone", target: "star_cape" });
    await sink.record({ action: "mcp.grant_created", owner: a, actor: "d_phone", meta: { provider: "chatgpt" } });
    await sink.record({ action: "store.purchase", owner: b, actor: "d_x", target: "viking_hat" });
    await sink.record({ action: "tenant.created", owner: null, actor: "hub" });
    await admin`insert into chalito.audit (owner, device_id, eid, type, meta, source)
                values (${a}, ${dev[a]!}, ${randomUUID()}, 'devmode.changed', '{"on": true}', 'deviceEvent'),
                       (${a}, ${dev[a]!}, ${randomUUID()}, 'approval.decision_rejected', '{}', 'agent')`;
    return { a, b };
  };

  describe("audit views", () => {
    it("an owner sees their own events, by category, and nobody else's", async () => {
      const { a, b } = await setup();
      const rows = await asUser(a, async (tx) => ({
        trail: await tx`select owner, type, category, origin from chalito.audit_trail`,
        devices: await tx`select type from chalito.audit_devices`,
        devmode: await tx`select type from chalito.audit_devmode`,
        connectors: await tx`select type from chalito.audit_connectors`,
        store: await tx`select type, target from chalito.audit_store`,
        approvals: await tx`select type from chalito.audit_approvals`,
      }));
      expect(rows.trail.every((r) => r.owner === a)).toBe(true);
      expect(rows.trail.map((r) => `${r.type}:${r.category}:${r.origin}`).sort()).toEqual([
        "approval.decision_rejected:approvals:device",
        "device.revoked:devices:server",
        "devmode.changed:devmode:device",
        "mcp.grant_created:connectors:server",
        "store.purchase:store:server",
      ]);
      expect(rows.devices.map((r) => r.type)).toEqual(["device.revoked"]);
      expect(rows.devmode.map((r) => r.type)).toEqual(["devmode.changed"]);
      expect(rows.connectors.map((r) => r.type)).toEqual(["mcp.grant_created"]);
      expect(rows.store).toEqual([{ type: "store.purchase", target: "star_cape" }]);
      expect(rows.approvals.map((r) => r.type)).toEqual(["approval.decision_rejected"]);
      expect((await asUser(b, (tx) => tx`select target from chalito.audit_store`)).map((r) => r.target)).toEqual([
        "viking_hat",
      ]);
    });

    it("clients can't write or rewrite the server audit, and anonymous users see nothing", async () => {
      const { a } = await setup();
      await expect(
        asUser(
          a,
          (tx) => tx`insert into chalito.server_audit (owner, action, actor) values (${a}, 'store.purchase', 'me')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(asUser(a, (tx) => tx`delete from chalito.server_audit where owner = ${a}`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(server`update chalito.server_audit set action = 'x' where owner = ${a}`).rejects.toThrow(
        /permission denied/,
      );
      const [r] = await admin`select has_table_privilege('anon', 'chalito.audit_trail', 'select') as anon`;
      expect(r!.anon).toBe(false);
    });

    it("the server's timestamp wins", async () => {
      const { a } = await setup();
      await server`insert into chalito.server_audit (owner, action, actor, t) values (${a}, 'device.enrolled', 'x', '2001-01-01')`;
      const [r] = await admin`select t from chalito.server_audit where owner = ${a} and action = 'device.enrolled'`;
      expect(new Date(r!.t as string).getFullYear()).toBeGreaterThan(2025);
    });
  });
}
