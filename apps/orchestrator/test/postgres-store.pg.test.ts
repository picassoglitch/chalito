import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { usageEvent } from "@chalito/billing";
import type { MesaDoc } from "../src/core/mesa.js";
import { PostgresMesaStore } from "../src/postgres-store.js";

/** PostgresMesaStore as CHALITO_DB_ROLE (chalito_server) on DATABASE_URL (migrations 001800/001900). */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE ?? "chalito_server";

describe.skipIf(!url)("PostgresMesaStore", () => {
  const admin = postgres(url ?? "postgres://unused", { max: 2, onnotice: () => {} });
  const sql = postgres(url ?? "postgres://unused", { max: 4, onnotice: () => {}, connection: { role } });
  const store = new PostgresMesaStore(sql);
  afterAll(async () => {
    await Promise.all([admin.end(), sql.end()]);
  });

  const seed = async () => {
    const owner = `o-${randomUUID()}`;
    const phone = `dp${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await admin.begin(async (tx) => {
      await tx`insert into chalito.tenants (id) values (${owner})`;
      await tx`insert into chalito.users (id, tenant_id) values (${owner}, ${owner})`;
      await tx`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
               values (${owner}, ${phone}, 'client', 'phone', 'ios', 'Phone', 'p', 'phonebox', 'f', 'first_client')`;
    });
    return { owner, phone };
  };
  const doc = (owner: string): MesaDoc => ({
    v: 1,
    kind: "mesa",
    participants: [
      { kind: "human", pid: "owner", name: "Aldo", uid: owner },
      { kind: "brain", pid: "claude", name: "Claude", provider: "anthropic", modelRef: "auto" },
    ],
    budget: { mesaTokens: 100_000, perParticipant: null },
    used: { total: 0, byParticipant: {} },
    status: "open",
    createdAt: 1,
  });
  const ev = (owner: string, src: string) =>
    usageEvent(
      { owner, billingMode: "managed", origin: "mesa.turn" },
      {
        kind: "llm.tokens",
        provider: "anthropic",
        amount: 30,
        costUsdMicros: 99,
        occurredAt: Date.now(),
        sourceId: src,
        metadata: { tokens: { input: 10, output: 10, cache_read: 5, cache_write: 5 } },
      },
    );

  it(`runs as ${role}`, async () => {
    expect((await sql`select current_user as u`)[0]?.u).toBe(role);
  });

  it("creates a Mesa once; reads clients and their status", async () => {
    const { owner, phone } = await seed();
    expect(await store.createMesa(owner, "m1", doc(owner))).toBe(true);
    expect(await store.createMesa(owner, "m1", doc(owner))).toBe(false);
    expect((await store.getMesa(owner, "m1"))!.participants).toHaveLength(2);
    expect(await store.clientBoxKeys(owner)).toEqual({ [phone]: "phonebox" });
    expect(await store.activeClient(owner, phone)).toBe(true);
    await admin`update chalito.devices set revoked = true where device_id = ${phone}`;
    expect(await store.activeClient(owner, phone)).toBe(false);
  });

  it("a turn, its usage event and the counters commit together; duplicates write nothing", async () => {
    const { owner } = await seed();
    await store.createMesa(owner, "m1", doc(owner));
    const spend = { pid: "claude", tokens: 30, events: [ev(owner, `${owner}:t1`)] };
    expect(await store.appendTurn(owner, "m1", "t1", { v: 1 }, spend)).toBe("ok");
    expect(await store.appendTurn(owner, "m1", "t1", { v: 1 }, { ...spend, events: [ev(owner, `${owner}:t1b`)] })).toBe(
      "duplicate",
    );
    await store.appendTurn(
      owner,
      "m1",
      "t2",
      { v: 1 },
      { pid: "claude", tokens: 12, events: [ev(owner, `${owner}:t2`)] },
    );
    expect((await store.getMesa(owner, "m1"))!.used).toEqual({ total: 42, byParticipant: { claude: 42 } });
    const out =
      await admin`select source_id from chalito_private.usage_outbox where owner = ${owner} order by source_id`;
    expect(out.map((r) => r.source_id)).toEqual([`${owner}:t1`, `${owner}:t2`]);
  });

  it("a failed turn write leaves no usage event behind", async () => {
    const { owner } = await seed();
    // No such Mesa: the turn's foreign key fails, and the outbox insert rolls back with it.
    await expect(
      store.appendTurn(owner, "nope", "t1", { v: 1 }, { pid: "claude", tokens: 30, events: [ev(owner, `${owner}:x`)] }),
    ).rejects.toThrow();
    expect(await admin`select 1 from chalito_private.usage_outbox where owner = ${owner}`).toHaveLength(0);
  });

  it("budget status; the gateway's MCP inbox isn't a Mesa", async () => {
    const { owner } = await seed();
    await store.createMesa(owner, "m1", doc(owner));
    await store.setStatus(owner, "m1", "budget_reached");
    expect((await store.getMesa(owner, "m1"))!.status).toBe("budget_reached");
    await admin`insert into chalito.mesas (owner, mid, doc) values (${owner}, 'mcp_inbox', '{"kind": "mcp_inbox"}')`;
    expect(await store.getMesa(owner, "mcp_inbox")).toBeNull();
  });
});
