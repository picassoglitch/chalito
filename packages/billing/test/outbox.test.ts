import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usageEvent } from "../src/billable.js";
import { HubClient } from "../src/hub.js";
import { MemoryOutbox, backoffMs, drainOutbox } from "../src/outbox.js";
import { hubMock } from "./hub-mock.js";

const { server, calls, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  calls.length = 0;
  state.usageStatus = 200;
});

const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: "t" });
const NOW = 1_790_000_000_000;
const ev = (i: number) =>
  usageEvent(
    { owner: "u1", billingMode: "managed", origin: "sms.message" },
    {
      kind: "sms.segments",
      provider: "twilio",
      amount: 1,
      costUsdMicros: 181_900,
      occurredAt: NOW,
      sourceId: `sms:${i}`,
    },
  );

describe("usage outbox", () => {
  it("drains in batches of ≤ 100 and marks rows sent", async () => {
    const box = new MemoryOutbox();
    await box.enqueue(
      "u1",
      Array.from({ length: 250 }, (_, i) => ev(i)),
    );
    const r = await drainOutbox({ store: box, hub, now: () => NOW, alert: () => {} });
    expect(r).toEqual({ sent: 250, retried: 0, dead: 0 });
    expect(calls.map((c) => (c.body as { events: unknown[] }).events.length)).toEqual([100, 100, 50]);
    expect(box.rows.every((x) => x.status === "sent")).toBe(true);
  });

  it("is idempotent on source_id", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev(1), ev(1), ev(2)]);
    expect(box.rows).toHaveLength(2);
  });

  it("retries 5xx/429 with backoff and stops for now", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev(1)]);
    state.usageStatus = 503;
    expect(await drainOutbox({ store: box, hub, now: () => NOW, alert: () => {} })).toEqual({
      sent: 0,
      retried: 1,
      dead: 0,
    });
    expect(box.rows[0]).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: NOW + backoffMs(0) });
    // Not due yet: nothing is sent.
    expect((await drainOutbox({ store: box, hub, now: () => NOW + 1_000, alert: () => {} })).retried).toBe(0);
    state.usageStatus = 429;
    await drainOutbox({ store: box, hub, now: () => NOW + backoffMs(0), alert: () => {} });
    expect(box.rows[0]).toMatchObject({ attempts: 2, nextAttemptAt: NOW + backoffMs(0) + backoffMs(1) });
    state.usageStatus = 200;
    await drainOutbox({ store: box, hub, now: () => NOW + 10 * 60_000, alert: () => {} });
    expect(box.rows[0]!.status).toBe("sent");
    expect(backoffMs(20)).toBe(60 * 60_000); // capped at 1 h
  });

  it("a permanent 4xx marks the rows dead and alerts; they are never dropped", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev(1), ev(2)]);
    state.usageStatus = 422;
    const alerts: unknown[] = [];
    expect(
      await drainOutbox({ store: box, hub, now: () => NOW, alert: (m, meta) => alerts.push({ m, meta }) }),
    ).toEqual({
      sent: 0,
      retried: 0,
      dead: 2,
    });
    expect(box.rows.map((r) => r.status)).toEqual(["dead", "dead"]);
    expect(box.rows[0]!.lastError).toMatch(/^422/);
    // The batch is bisected (R-M6): each row the hub still refuses alone is dead, one alert each.
    expect(alerts).toEqual([
      { m: "billing.usage_dead", meta: { count: 1, httpStatus: 422, sourceIds: ["sms:1"] } },
      { m: "billing.usage_dead", meta: { count: 1, httpStatus: 422, sourceIds: ["sms:2"] } },
    ]);
    // A later drain doesn't resend dead rows.
    calls.length = 0;
    state.usageStatus = 200;
    await drainOutbox({ store: box, hub, now: () => NOW + 1e9, alert: () => {} });
    expect(calls).toHaveLength(0);
  });

  it("malformed or mismatched rows are dead-lettered and alerted, never sent", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev(1), ev(2)]);
    // A row whose stored event is a string (double-encoded) and one whose source_id differs.
    box.rows[0]!.event = JSON.stringify(box.rows[0]!.event) as never;
    box.rows[1]!.event = { ...box.rows[1]!.event, source_id: "other" };
    await box.enqueue("u1", [ev(3)]);
    const alerts: { m: string; meta: unknown }[] = [];
    const r = await drainOutbox({ store: box, hub, now: () => NOW, alert: (m, meta) => alerts.push({ m, meta }) });
    expect(r).toEqual({ sent: 1, retried: 0, dead: 2 });
    expect(box.rows.map((x) => x.status)).toEqual(["dead", "dead", "sent"]);
    expect(alerts).toEqual([{ m: "billing.usage_invalid", meta: { count: 2, sourceIds: ["sms:1", "sms:2"] } }]);
    const sent = calls.flatMap((c) => (c.body as { events: { source_id: string }[] }).events.map((e) => e.source_id));
    expect(sent).toEqual(["sms:3"]);
  });
});

describe("R-M6: bisecting a refused batch", () => {
  it("a retry from the hub mid-bisection defers the untried half instead of dropping or killing it", async () => {
    const box = new MemoryOutbox();
    await box.enqueue("u1", [ev(1), ev(2), ev(3), ev(4)]);
    let n = 0;
    const flaky = {
      usage: async () => {
        n++;
        if (n === 1) return { status: "dead" as const, httpStatus: 404, error: "unknown user_id" };
        return { status: "retry" as const, httpStatus: 503, error: "down" };
      },
    };
    expect(await drainOutbox({ store: box, hub: flaky as never, now: () => NOW, alert: () => {} })).toEqual({
      sent: 0,
      retried: 4,
      dead: 0,
    });
    expect(box.rows.every((r) => r.status === "pending" && r.nextAttemptAt > NOW)).toBe(true);
  });
});
