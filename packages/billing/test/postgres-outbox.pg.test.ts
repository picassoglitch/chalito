import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { usageEvent } from "../src/billable.js";
import type { OutboxRow } from "../src/outbox.js";
import { PostgresOutbox, enqueueUsage } from "../src/postgres-outbox.js";

/** chalito_private.usage_outbox (migration 20261004001500) as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresOutbox", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const sql = postgres(url, { max: 4, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  const outbox = new PostgresOutbox(sql);
  afterAll(() => sql.end());
  const NOW = Date.now();
  const ev = (owner: string, src: string) =>
    usageEvent(
      { owner, billingMode: "managed", origin: "whatsapp.message" },
      { kind: "whatsapp.messages", provider: "meta", amount: 1, costUsdMicros: 8_500, occurredAt: NOW, sourceId: src },
    );

  describe("PostgresOutbox", () => {
    it.runIf(role)(`runs as ${role}`, async () => {
      expect((await sql`select current_user as u`)[0]?.u).toBe(role);
    });

    it("commits with the work's transaction, or not at all", async () => {
      const owner = `o-${randomUUID()}`;
      await expect(
        sql.begin(async (tx) => {
          await enqueueUsage(tx, owner, [ev(owner, `${owner}:a`)]);
          throw new Error("the work failed");
        }),
      ).rejects.toThrow("the work failed");
      expect(await sql`select 1 from chalito_private.usage_outbox where owner = ${owner}`).toHaveLength(0);
      await sql.begin((tx) => enqueueUsage(tx, owner, [ev(owner, `${owner}:a`), ev(owner, `${owner}:a`), null]));
      expect(await sql`select 1 from chalito_private.usage_outbox where owner = ${owner}`).toHaveLength(1);
    });

    it("concurrent drainers claim disjoint rows; sent and dead rows are never claimed again", async () => {
      const owner = `o-${randomUUID()}`;
      await enqueueUsage(
        sql,
        owner,
        Array.from({ length: 6 }, (_, i) => ev(owner, `${owner}:${i}`)),
      );
      const mine = (rows: OutboxRow[]) => rows.filter((r) => r.event.source_id.startsWith(owner));
      // Claim in rounds (a shared database may hold other pending rows): two drainers at a time
      // never get the same row, and every one of ours is claimed exactly once.
      const all: OutboxRow[] = [];
      for (let round = 0; round < 50 && all.length < 6; round++) {
        const [a, b] = await Promise.all([outbox.claimDue(100, NOW + 1_000), outbox.claimDue(100, NOW + 1_000)]);
        const ia = new Set(a.map((r) => r.id));
        expect(b.some((r) => ia.has(r.id))).toBe(false);
        if (a.length + b.length === 0) break;
        all.push(...mine(a), ...mine(b));
      }
      const ids = all.map((r) => r.event.source_id).sort();
      expect(ids).toEqual(Array.from({ length: 6 }, (_, i) => `${owner}:${i}`).sort());
      await outbox.markSent(
        all.slice(0, 3).map((r) => r.id),
        NOW,
      );
      await outbox.markDead([all[3]!.id], "422: bad kind");
      await outbox.markRetry(
        all.slice(4).map((r) => r.id),
        NOW + 30_000,
        "503",
      );
      expect(mine(await outbox.claimDue(100, NOW + 10_000))).toHaveLength(0); // retries not due yet
      const later = mine(await outbox.claimDue(100, NOW + 6 * 60_000));
      expect(later.map((r) => r.attempts)).toEqual([1, 1]);
      const [dead] = await sql`select status, last_error from chalito_private.usage_outbox where id = ${all[3]!.id}`;
      expect(dead).toEqual({ status: "dead", last_error: "422: bad kind" });
    });
  });
}
