import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { loadPlans } from "@chalito/config";
import { pgVoiceCap } from "../src/voice/caps.js";

/** A complete HubUsageEvent, as the outbox CHECK requires (source_id must match the row). */
const fixtureEvent = (sourceId: string, owner: string, kind: string, amount: number) => ({
  source_id: sourceId,
  kind,
  provider: "test",
  external_user_id: owner,
  amount,
  cost_usd_micros: 1,
  occurred_at: new Date().toISOString(),
});

/** pgVoiceCap against chalito.users + the usage outbox (migrations 001100, 001500), as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("pgVoiceCap", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 2, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });

  describe("pgVoiceCap", () => {
    it("reads the plan's voice minutes and this month's voice seconds; the note is once a month", async () => {
      const u = `cap-${randomUUID()}`;
      await admin`insert into chalito.tenants (id) values (${u})`;
      await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${u}, ${u}, 'pro', 'America/Mexico_City')`;
      await admin`insert into chalito_private.usage_outbox (owner, source_id, event)
                  values (${u}, ${`v1:${u}`}, ${admin.json(fixtureEvent(`v1:${u}`, u, "voice.seconds", 600))}),
                         (${u}, ${`w1:${u}`}, ${admin.json(fixtureEvent(`w1:${u}`, u, "whatsapp.messages", 1))})`;
      const cap = pgVoiceCap(sql, loadPlans(), () => false);
      expect(await cap.status(u, Date.now())).toEqual({ limitSeconds: 120 * 60, usedSeconds: 600 });
      await cap.note(u, Date.now());
      await cap.note(u, Date.now());
      expect(
        await admin`select count(*)::int as n from chalito.notifications where owner = ${u} and coalesce_key = 'cap:voice'`,
      ).toEqual([{ n: 1 }]);
    });
  });
}
