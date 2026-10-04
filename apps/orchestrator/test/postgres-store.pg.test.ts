import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { usageEvent } from "@chalito/billing";
import { generateSigningKeyPair, randomNonce, signEnvelope, toB64url } from "@chalito/crypto";
import { processDecisions } from "../src/decisions.js";
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

  it("decisions: creates a pending kind=decision approval on the database clock", async () => {
    const { owner, phone } = await seed();
    await store.createDecisionApproval(owner, {
      aid: "apr_1",
      mid: "m1",
      tid: "t1",
      origin: `client:${phone}`,
      detailsCt: { alg: "xchacha20poly1305+sealedbox", nonce: "n", ct: "c", keys: {} },
    });
    const [a] = await admin`select kind, status, device_id, risk, origin, expires_at - created_at as ttl
                            from chalito.approvals where owner = ${owner} and aid = 'apr_1'`;
    expect(a).toMatchObject({
      kind: "decision",
      status: "pending",
      device_id: "orchestrator",
      risk: "MED",
      origin: `client:${phone}`,
    });
  });

  it("BYO keys: sealed row + wrapped copy; cloud off drops the copy; delete removes both", async () => {
    const { owner } = await seed();
    const row = {
      provider: "openai" as const,
      sealedCt: { alg: "x", nonce: "n", ct: "c", keys: {} },
      hint: "1234",
      cloud: true,
    };
    await store.putBrainKey(owner, row as never, "wrapped-1");
    expect(await store.wrappedBrainKey(owner, "openai")).toBe("wrapped-1");
    await store.putBrainKey(owner, { ...row, cloud: false } as never, null);
    expect(await store.wrappedBrainKey(owner, "openai")).toBeNull();
    expect((await admin`select cloud from chalito.brain_keys where owner = ${owner}`)[0]!.cloud).toBe(false);
    expect(await store.deleteBrainKey(owner, "openai")).toBe(true);
    expect(await store.deleteBrainKey(owner, "openai")).toBe(false);
  });

  it("usage: managed events from the outbox by day and purpose, BYO turns from the Mesa", async () => {
    const { owner } = await seed();
    await store.createMesa(owner, "m1", doc(owner));
    const t = Date.now();
    await store.appendTurn(
      owner,
      "m1",
      "t1",
      { v: 1 },
      { pid: "claude", tokens: 30, events: [ev(owner, `${owner}:u1`)] },
    );
    await store.appendTurn(
      owner,
      "m1",
      "t2",
      { v: 1, t, billingMode: "byo", usage: { in: 100, out: 20, cached: 5 }, estCostUsdMicros: 7 },
      { pid: "claude", tokens: 125, events: [null] },
    );
    const rows = await store.usageDaily(owner, t - 86_400_000);
    const day = new Date(t).toISOString().slice(0, 10);
    expect(rows).toEqual(
      expect.arrayContaining([
        { day, billing: "managed", purpose: "work", tokens: 30, costUsdMicros: 99 },
        { day, billing: "byo", purpose: "work", tokens: 125, costUsdMicros: 7 },
      ]),
    );
  });

  it("decisions: a verified signature resolves through the SQL function; garbage and revoked signers don't", async () => {
    const owner = `o-${randomUUID()}`;
    const keys = await generateSigningKeyPair();
    const dev = (n: string) => `dv${n}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const phone = dev("p");
    const thief = dev("t");
    await admin.begin(async (tx) => {
      await tx`insert into chalito.tenants (id) values (${owner})`;
      await tx`insert into chalito.users (id, tenant_id) values (${owner}, ${owner})`;
      await tx`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via)
               values (${owner}, ${phone}, 'client', 'phone', 'ios', 'Phone', ${await toB64url(keys.publicKey)}, 'b', 'f', 'first_client'),
                      (${owner}, ${thief}, 'client', 'phone', 'ios', 'Stolen', ${await toB64url(keys.publicKey)}, 'b', 'f', 'endorsement')`;
    });
    const mk = async (aid: string) =>
      store.createDecisionApproval(owner, {
        aid,
        mid: "m1",
        tid: `t_${aid}`,
        origin: `client:${phone}`,
        detailsCt: { alg: "xchacha20poly1305+sealedbox", nonce: "n", ct: "c", keys: {} },
      });
    const body = async (aid: string) => ({
      v: 1 as const,
      aid,
      requestId: `t_${aid}`,
      uid: owner,
      targetDeviceId: "orchestrator",
      allow: true,
      nonce: await randomNonce(),
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
    });
    const insert = (aid: string, signer: string, decision: unknown) =>
      admin`insert into chalito.approval_decisions (owner, aid, signer_device_id, decision, rev)
            values (${owner}, ${aid}, ${signer}, ${admin.json(decision as never)}, 1)`;
    const audits: string[] = [];
    const rejected = new Set<string>();
    const run = (aid: string) =>
      processDecisions({ store, now: Date.now, audit: (e) => void audits.push(e.action), rejected }, { owner, aid });
    const status = async (aid: string) =>
      (await admin`select status from chalito.approvals where owner = ${owner} and aid = ${aid}`)[0]!.status;

    await mk("a1");
    await insert("a1", thief, {
      ctx: "chalito.decision.v1",
      signerDeviceId: thief,
      body: await body("a1"),
      sig: "A".repeat(86),
    });
    expect((await run("a1")).resolved).toEqual([]);
    expect(await status("a1")).toBe("pending");
    await insert("a1", phone, await signEnvelope("chalito.decision.v1", await body("a1"), phone, keys.secretKey));
    expect((await run("a1")).resolved).toEqual([{ owner, aid: "a1", status: "approved", signer: phone }]);
    expect(await status("a1")).toBe("approved");

    await mk("a2");
    await insert("a2", phone, await signEnvelope("chalito.decision.v1", await body("a2"), phone, keys.secretKey));
    await admin`update chalito.devices set revoked = true where device_id = ${phone}`;
    expect((await run("a2")).resolved).toEqual([]);
    expect(await status("a2")).toBe("pending");
    expect(audits).toEqual(["decision.invalid_signature", "decision.resolved", "decision.invalid_signature"]);

    // Migration 003510: the same device's rejected attempt doesn't block its next, valid one.
    await admin`update chalito.devices set revoked = false where device_id = ${phone}`;
    await mk("a3");
    await insert("a3", phone, {
      ctx: "chalito.decision.v1",
      signerDeviceId: phone,
      body: await body("a3"),
      sig: "A".repeat(86),
    });
    expect((await run("a3")).resolved).toEqual([]);
    await insert("a3", phone, await signEnvelope("chalito.decision.v1", await body("a3"), phone, keys.secretKey));
    expect((await run("a3")).resolved).toEqual([{ owner, aid: "a3", status: "approved", signer: phone }]);
    expect(await status("a3")).toBe("approved");
  });
});
