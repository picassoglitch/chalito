import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubClient } from "../src/hub.js";
import { usageEvent } from "../src/billable.js";
import { hubMock } from "./hub-mock.js";

const { server, calls, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  calls.length = 0;
  state.usageStatus = 200;
});

const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" });
const event = (i = 0) =>
  usageEvent(
    { owner: "u1", billingMode: "managed", origin: "whatsapp.message" },
    {
      kind: "whatsapp.messages",
      provider: "meta",
      amount: 1,
      costUsdMicros: 8_500,
      occurredAt: Date.now(),
      sourceId: `wa:${i}`,
    },
  )!;

describe("HubClient (engine contract)", () => {
  it("only talks to https://www.chalyb.com, with the engine bearer", async () => {
    expect(() => new HubClient({ baseUrl: "https://evil.example", token: "t" })).toThrow(
      /must be https:\/\/www\.chalyb\.com/,
    );
    expect(() => new HubClient({ baseUrl: "http://www.chalyb.com", token: "t" })).toThrow();
    expect(() => new HubClient({ baseUrl: "https://www.chalyb.com", token: "" })).toThrow();
    await hub.admit({
      external_user_id: "u1",
      external_job_id: "j1",
      class: "job",
      operation: "companion.turn",
      est_tokens: 10,
    });
    expect(calls[0]).toMatchObject({ path: "admit", auth: "Bearer chalito-admin-token" });
    expect(calls[0]!.body).toMatchObject({
      external_user_id: "u1",
      external_job_id: "j1",
      class: "job",
      est_tokens: 10,
      boost: null,
    });
  });

  it("classifies usage outcomes: ok, retry (network, 5xx, 408, 429), dead (other 4xx)", async () => {
    expect(await hub.usage([event()])).toEqual({ status: "ok" });
    for (const s of [500, 503, 408, 429] as const) {
      state.usageStatus = s;
      expect((await hub.usage([event()])).status).toBe("retry");
    }
    state.usageStatus = "network";
    expect(await hub.usage([event()])).toMatchObject({ status: "retry", httpStatus: null });
    for (const s of [400, 401, 403, 409, 422] as const) {
      state.usageStatus = s;
      expect(await hub.usage([event()])).toMatchObject({ status: "dead", httpStatus: s });
    }
  });

  it("sends at most 100 events per batch, each with cost_usd_micros", async () => {
    await expect(hub.usage(Array.from({ length: 101 }, (_, i) => event(i)))).rejects.toThrow();
    await hub.usage(Array.from({ length: 100 }, (_, i) => event(i)));
    const sent = (calls.at(-1)!.body as { events: Record<string, unknown>[] }).events;
    expect(sent).toHaveLength(100);
    expect(sent.every((e) => typeof e.cost_usd_micros === "number")).toBe(true);
  });

  it("settles and reads the balance", async () => {
    await hub.settle({ reservation_id: "11111111-1111-4111-8111-111111111111", outcome: "succeeded" });
    expect(calls.at(-1)).toMatchObject({ path: "settle", body: { outcome: "succeeded" } });
    expect(await hub.balance("u 1")).toEqual({ remaining: 42_000, reserved: 0 });
    expect(calls.at(-1)!.path).toBe("balance?external_user_id=u+1");
    state.balance = { balance: { remaining: 7, reserved: 1 } };
    expect(await hub.balance("u1")).toMatchObject({ remaining: 7 });
  });
});
