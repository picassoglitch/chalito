import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubClient, HubUnavailable } from "../src/hub.js";
import { usageEvent } from "../src/billable.js";
import { HUB_TOKEN, hubMock } from "./hub-mock.js";

const { server, calls, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  calls.length = 0;
  state.usageStatus = 200;
});

const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: HUB_TOKEN });
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
    expect(() => new HubClient({ baseUrl: "https://evil.example", token: HUB_TOKEN })).toThrow(
      /must be https:\/\/www\.chalyb\.com/,
    );
    expect(() => new HubClient({ baseUrl: "http://www.chalyb.com", token: HUB_TOKEN })).toThrow();
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
    expect(await hub.usage("u1", [event()])).toEqual({ status: "ok" });
    for (const s of [500, 503, 408, 429] as const) {
      state.usageStatus = s;
      expect((await hub.usage("u1", [event()])).status).toBe("retry");
    }
    state.usageStatus = "network";
    expect(await hub.usage("u1", [event()])).toMatchObject({ status: "retry", httpStatus: null });
    for (const s of [400, 401, 403, 409, 422] as const) {
      state.usageStatus = s;
      expect(await hub.usage("u1", [event()])).toMatchObject({ status: "dead", httpStatus: s });
    }
  });

  it("sends one user's events (top-level external_user_id, ≤100), each with cost_usd_micros", async () => {
    await expect(
      hub.usage(
        "u1",
        Array.from({ length: 101 }, (_, i) => event(i)),
      ),
    ).rejects.toThrow();
    // Another user's event in the batch is refused before it leaves.
    await expect(hub.usage("u2", [event()])).rejects.toThrow(/external_user_id/);
    expect(
      await hub.usage(
        "u1",
        Array.from({ length: 100 }, (_, i) => event(i)),
      ),
    ).toEqual({ status: "ok" });
    const body = calls.at(-1)!.body as { external_user_id: string; events: Record<string, unknown>[] };
    expect(body.external_user_id).toBe("u1");
    expect(body.events).toHaveLength(100);
    expect(body.events.every((e) => typeof e.cost_usd_micros === "number")).toBe(true);
  });

  it("settle reports a closed reservation (409) separately", async () => {
    expect(await hub.settle({ reservation_id: "11111111-1111-4111-8111-111111111111", outcome: "succeeded" })).toEqual({
      ok: true,
    });
    expect(calls.at(-1)).toMatchObject({ path: "settle", body: { outcome: "succeeded" } });
    state.settleStatus = 409;
    expect(await hub.settle({ reservation_id: "11111111-1111-4111-8111-111111111111", outcome: "heartbeat" })).toEqual({
      ok: false,
      closed: true,
    });
    state.settleStatus = 404;
    expect(await hub.settle({ reservation_id: "11111111-1111-4111-8111-111111111111", outcome: "succeeded" })).toEqual({
      ok: false,
      closed: false,
      httpStatus: 404,
    });
    state.settleStatus = 200;
  });

  it("reads the balance in the hub's exact TokenBalance shape", async () => {
    expect(await hub.balance("u 1")).toEqual({
      remaining: 42_000,
      reserved: 0,
      unlimited: false,
      monthlyAllocation: 100_000,
      bonus: 0,
      monthlyUsed: 58_000,
      periodStart: "2026-10-01T00:00:00.000Z",
    });
    expect(calls.at(-1)!.path).toBe("balance?external_user_id=u+1");
    // chalyb main has no `reserved` yet: it defaults to 0.
    const { reserved: _r, ...mainShape } = (state.balance as { balance: Record<string, unknown> }).balance;
    state.balance = { ok: true, balance: mainShape };
    expect((await hub.balance("u1")).reserved).toBe(0);
    // A bare {remaining, reserved} (the old guess) is rejected.
    state.balance = { remaining: 7, reserved: 1 };
    await expect(hub.balance("u1")).rejects.toThrow();
    state.balanceStatus = 404;
    await expect(hub.balance("u1")).rejects.toBeInstanceOf(HubUnavailable);
    state.balanceStatus = 200;
  });

  it("admit: 404 (unknown user, or a hub without the route yet) is HubUnavailable", async () => {
    state.admitStatus = 404;
    await expect(
      hub.admit({
        external_user_id: "u1",
        external_job_id: "j1",
        class: "job",
        operation: "companion.turn",
        est_tokens: 1,
      }),
    ).rejects.toMatchObject({ name: "Error", httpStatus: 404 });
    state.admitStatus = 200;
  });

  it("admit requests follow the hub's field rules (job id, operation, ttl)", async () => {
    const ok = {
      external_user_id: "u1",
      external_job_id: "whatsapp:n1:1790000000000",
      class: "job" as const,
      operation: "whatsapp.message",
      est_tokens: 1,
    };
    await hub.admit(ok);
    await expect(hub.admit({ ...ok, external_job_id: "has spaces" })).rejects.toThrow();
    await expect(hub.admit({ ...ok, external_job_id: "x".repeat(129) })).rejects.toThrow();
    await expect(hub.admit({ ...ok, operation: "Bad-Op" })).rejects.toThrow();
    await expect(hub.admit({ ...ok, ttl_seconds: 30 })).rejects.toThrow();
    await expect(hub.admit({ ...ok, ttl_seconds: 90_000 })).rejects.toThrow();
  });
});
