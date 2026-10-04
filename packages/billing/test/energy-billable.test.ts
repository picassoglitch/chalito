import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadRechargeCopy } from "@chalito/config";
import { isBillable, usageEvent, type BillingMode, type UsageOrigin } from "../src/billable.js";
import { admitManaged, outOfEnergy } from "../src/energy.js";
import { HubClient } from "../src/hub.js";
import { MemoryOutbox, drainOutbox } from "../src/outbox.js";
import { hubMock } from "./hub-mock.js";

const { server, calls, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
const defaultAdmit = state.admit;
beforeEach(() => {
  calls.length = 0;
  state.admit = defaultAdmit;
});

const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: "t" });
const request = {
  external_user_id: "u1",
  external_job_id: "turn-1",
  class: "job" as const,
  operation: "companion.turn",
  est_tokens: 500,
};
const enabled = { managedAllowance: { status: "enabled" as const, remainingBillable: 1_000 } };

describe("out of energy, in character", () => {
  it("no_tokens → the turn finishes on free_min with a recharge line and an inline ¿Por qué? chip to /creditos", async () => {
    state.admit = () => ({ ok: true, allowed: false, reason: "no_tokens" });
    const gate = await admitManaged({ hub, entitlements: enabled, request, locale: "es" });
    expect(gate.ok).toBe(false);
    if (gate.ok || !("outOfEnergy" in gate)) throw new Error("expected out of energy");
    expect(gate.outOfEnergy).toMatchObject({
      profile: "free_min",
      animation: "tired",
      presentation: "inline",
      chip: { label: "¿Por qué?", href: "/creditos" },
    });
    expect(loadRechargeCopy("es").lines).toContain(gate.outOfEnergy.line);
    expect(JSON.stringify(gate)).not.toMatch(/modal|dialog/i);
  });

  it("a zero balance on admit cancels the reservation and is out of energy too; English goes to /en/creditos", async () => {
    state.admit = () => ({
      ok: true,
      allowed: true,
      reservation_id: "22222222-2222-4222-8222-222222222222",
      lane: "standard",
      boost_fee_tokens: 0,
      limits: {},
      balance: { remaining: 0, reserved: 0 },
    });
    const gate = await admitManaged({ hub, entitlements: enabled, request, locale: "en" });
    expect(gate).toMatchObject({ ok: false, outOfEnergy: { chip: { label: "Why?", href: "/en/creditos" } } });
    expect(calls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(calls[1]!.body).toEqual({ reservation_id: "22222222-2222-4222-8222-222222222222", outcome: "cancelled" });
  });

  it("free_min entitlements never call the hub; other refusals and an unreachable hub fail closed without a recharge line", async () => {
    expect(
      await admitManaged({ hub, entitlements: { managedAllowance: { status: "free_min" } }, request, locale: "es" }),
    ).toMatchObject({
      ok: false,
      outOfEnergy: { profile: "free_min" },
    });
    expect(
      await admitManaged({
        hub,
        entitlements: { managedAllowance: { status: "disabled_unset" } },
        request,
        locale: "es",
      }),
    ).toEqual({
      ok: false,
      refused: "allowance_unset",
      profile: "free_min",
    });
    expect(calls).toHaveLength(0);
    state.admit = () => ({ ok: true, allowed: false, reason: "concurrency" });
    expect(await admitManaged({ hub, entitlements: enabled, request, locale: "es" })).toEqual({
      ok: false,
      refused: "concurrency",
      profile: "free_min",
    });
    const down = new HubClient({
      baseUrl: "https://www.chalyb.com",
      token: "t",
      fetch: async () => {
        throw new Error("down");
      },
    });
    expect(await admitManaged({ hub: down, entitlements: enabled, request, locale: "es" })).toEqual({
      ok: false,
      refused: "hub_unavailable",
      profile: "free_min",
    });
  });

  it("admits when the balance covers it", async () => {
    expect(await admitManaged({ hub, entitlements: enabled, request, locale: "es" })).toEqual({
      ok: true,
      reservationId: "11111111-1111-4111-8111-111111111111",
      remaining: 50_000,
    });
  });

  it("lines are deterministic per key and come from the copy files", () => {
    expect(outOfEnergy("es", "k").line).toBe(outOfEnergy("es", "k").line);
    expect(new Set(Array.from({ length: 40 }, (_, i) => outOfEnergy("es", `k${i}`).line)).size).toBeGreaterThan(1);
  });
});

describe("never billable: BYO usage and Claude Code / Codex sessions", () => {
  const modes: BillingMode[] = ["managed", "byo_api_key", "byo_subscription_local", "byo_mcp_connector"];
  const origins: UsageOrigin[] = [
    "companion.turn",
    "mesa.turn",
    "voice.desktop",
    "session.claude-code",
    "session.codex",
  ];

  it("produce no hub events, so nothing reaches the outbox or the hub", async () => {
    const box = new MemoryOutbox();
    let i = 0;
    for (const billingMode of modes)
      for (const origin of origins) {
        const e = usageEvent(
          { owner: "u1", billingMode, origin },
          {
            kind: "llm.tokens",
            provider: "anthropic",
            amount: 30,
            costUsdMicros: 100,
            occurredAt: Date.now(),
            sourceId: `s${i++}`,
            metadata: { tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0 } },
          },
        );
        expect(e === null).toBe(!(billingMode === "managed" && !origin.startsWith("session.")));
        await box.enqueue("u1", [e]);
      }
    expect(box.rows.map((r) => r.event.source_id)).toEqual(["s0", "s1", "s2"]); // managed companion, mesa, voice only
    await drainOutbox({ store: box, hub, now: () => Date.now(), alert: () => {} });
    const sent = calls
      .filter((c) => c.path === "usage")
      .flatMap((c) => (c.body as { events: { source_id: string }[] }).events);
    expect(sent.map((e) => e.source_id)).toEqual(["s0", "s1", "s2"]);
    expect(isBillable({ owner: "u1", billingMode: "managed", origin: "session.codex" })).toBe(false);
  });

  it("an llm.tokens event's amount must equal its token split", () => {
    expect(() =>
      usageEvent(
        { owner: "u1", billingMode: "managed", origin: "companion.turn" },
        {
          kind: "llm.tokens",
          provider: "anthropic",
          amount: 31,
          costUsdMicros: 1,
          occurredAt: Date.now(),
          metadata: { tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0 } },
        },
      ),
    ).toThrow();
  });
});
