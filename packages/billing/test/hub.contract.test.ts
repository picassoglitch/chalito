import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubUsageKind } from "@chalito/protocol";
import { usageEvent } from "../src/billable.js";
import { HubClient } from "../src/hub.js";
import { MemoryOutbox, drainOutbox } from "../src/outbox.js";
import { checkAdmitRequest, checkSettleRequest, checkUsageRequest, SETTLE_OUTCOMES } from "./hub-contract.js";
import { HUB_TOKEN, hubMock } from "./hub-mock.js";

/**
 * Contract tests against the hub's own validation (hub-contract.ts, copied from chalyb a5733df and
 * main 3f27ef3): every request HubClient makes must be one the real hub accepts.
 */
const { server, calls, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
const NOW = 1_790_000_000_000;
beforeEach(() => {
  calls.length = 0;
  state.usageStatus = 200;
  state.now = () => NOW;
});
const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: HUB_TOKEN });
const ev = (owner: string, i: number) =>
  usageEvent(
    { owner, billingMode: "managed", origin: "sms.message" },
    {
      kind: "sms.segments",
      provider: "twilio",
      amount: 1,
      costUsdMicros: 181_900,
      occurredAt: NOW,
      sourceId: `sms:${owner}:${i}`,
    },
  );

describe("POST /usage", () => {
  it("the real hub refuses a batch without a top-level external_user_id (the old shape)", async () => {
    const res = await fetch("https://www.chalyb.com/api/engines/chalito/usage", {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [ev("u1", 0)] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "external_user_id required" });
  });

  it("a drain of several owners sends one accepted request per owner", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev("u1", 0), ev("u1", 1)]);
    await box.enqueue("u2", [ev("u2", 0)]);
    await box.enqueue("u1", [ev("u1", 2)]);
    expect(await drainOutbox({ store: box, hub, now: () => NOW, alert: () => {} })).toEqual({
      sent: 4,
      retried: 0,
      dead: 0,
    });
    const usage = calls
      .filter((c) => c.path === "usage")
      .map((c) => c.body as { external_user_id: string; events: { external_user_id: string }[] });
    expect(usage.map((b) => [b.external_user_id, b.events.length])).toEqual([
      ["u1", 3],
      ["u2", 1],
    ]);
    for (const b of usage) expect(checkUsageRequest(b, NOW)).toBeNull();
  });

  it("when the hub asks to retry, the owners not yet sent are deferred, not lost", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev("u1", 0)]);
    await box.enqueue("u2", [ev("u2", 0)]);
    state.usageStatus = 503;
    expect(await drainOutbox({ store: box, hub, now: () => NOW, alert: () => {} })).toEqual({
      sent: 0,
      retried: 2,
      dead: 0,
    });
    expect(calls.filter((c) => c.path === "usage")).toHaveLength(1);
    expect(box.rows.every((r) => r.status === "pending" && r.nextAttemptAt > NOW)).toBe(true);
  });

  it("every event our builders make passes the hub's own event rules", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HubUsageKind.options),
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 0, max: 6 * 24 * 3_600_000 }),
        (kind, amount, cost, age) => {
          const e = usageEvent(
            { owner: "u1", billingMode: "managed", origin: "companion.turn" },
            {
              kind,
              provider: "openai",
              amount,
              costUsdMicros: cost,
              occurredAt: NOW - age,
              sourceId: `p:${kind}:${amount}`,
              reservationId: "11111111-1111-4111-8111-111111111111",
              ...(kind === "llm.tokens"
                ? { metadata: { tokens: { input: amount, output: 0, cache_read: 0, cache_write: 0 }, model: "m" } }
                : {}),
            },
          );
          expect(e).not.toBeNull();
          expect(checkUsageRequest({ external_user_id: "u1", events: [e] }, NOW)).toBeNull();
        },
      ),
    );
  });
});

describe("admit, settle, balance", () => {
  it("admit sends what parseAdmitBody accepts", async () => {
    await hub.admit({
      external_user_id: "u1",
      external_job_id: "voice_x:1",
      class: "stream",
      operation: "voice.session",
      est_tokens: 120,
      ttl_seconds: 900,
    });
    expect(checkAdmitRequest(calls.at(-1)!.body)).toBeNull();
  });

  it("settle sends a UUID and one of the hub's outcomes, for each outcome", async () => {
    for (const outcome of SETTLE_OUTCOMES) {
      await hub.settle({ reservation_id: "11111111-1111-4111-8111-111111111111", outcome });
      expect(checkSettleRequest(calls.at(-1)!.body)).toBeNull();
    }
  });

  it("balance asks with the external_user_id query parameter", async () => {
    await hub.balance("u 1");
    expect(calls.at(-1)!.path).toBe("balance?external_user_id=u+1");
  });
});
