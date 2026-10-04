import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresBuckets } from "../src/index.js";

/** chalito_private.http_rate_buckets (migration 002700), as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresBuckets", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const sql = postgres(url, { max: 8, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(() => sql.end());
  const key = () => createHash("sha256").update(randomUUID()).digest("hex");

  describe("PostgresBuckets", () => {
    it("spends and refills one bucket shared by every caller", async () => {
      const b = new PostgresBuckets(sql);
      const k = key();
      const t = Date.now();
      expect([await b.take(k, 2, 1, t), await b.take(k, 2, 1, t), await b.take(k, 2, 1, t)]).toEqual([
        true,
        true,
        false,
      ]);
      expect(await b.take(k, 2, 1, t + 1500)).toBe(true);
    });

    it("concurrent instances can't overspend the last tokens", async () => {
      const b = new PostgresBuckets(sql);
      const k = key();
      const t = Date.now();
      const got = await Promise.all(Array.from({ length: 20 }, () => b.take(k, 5, 0.001, t)));
      expect(got.filter(Boolean)).toHaveLength(5);
    });
  });
}
