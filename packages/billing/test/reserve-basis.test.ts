import { readFileSync } from "node:fs";
import { loadPrices } from "@chalito/config";
import { describe, expect, it } from "vitest";
import { voiceSecondsCostMicros } from "../src/cost.js";
import type { HubClient } from "../src/hub.js";
import { HUB_MARGIN_PERCENT, parseReserveBasis, reserveTokens, type ReserveBasis } from "../src/reserve-basis.js";
import { HubStreamUsage } from "../src/stream-usage.js";
import { HUB_DEFAULT_MARGIN_PERCENT, hubBillableTokens, hubReserve } from "./hub-contract.js";

describe("HUB_RESERVE_BASIS", () => {
  it("defaults to pre_margin and accepts both values", () => {
    expect(parseReserveBasis(undefined)).toBe("pre_margin");
    expect(parseReserveBasis("")).toBe("pre_margin");
    expect(parseReserveBasis("pre_margin")).toBe("pre_margin");
    expect(parseReserveBasis("post_margin")).toBe("post_margin");
  });

  it("refuses anything else, loudly", () => {
    for (const bad of ["PRE_MARGIN", "pre", "post-margin", " pre_margin", "true"])
      expect(() => parseReserveBasis(bad)).toThrow(/HUB_RESERVE_BASIS/);
  });

  it("is parsed at startup by every service that admits", () => {
    // A module-level parse: a bad value stops the service before it serves, not at the first admit.
    for (const app of ["api", "notifier", "orchestrator"]) {
      const src = readFileSync(new URL(`../../../apps/${app}/src/server.ts`, import.meta.url), "utf8");
      expect(src, app).toMatch(/^const reserveBasis = parseReserveBasis\(process\.env\.HUB_RESERVE_BASIS\);$/m);
    }
  });

  it("pre_margin is the cost in tokens; post_margin adds the hub's margin", () => {
    expect(reserveTokens(10_000, "pre_margin")).toBe(2_500);
    expect(reserveTokens(10_001, "pre_margin")).toBe(2_501);
    expect(reserveTokens(10_000, "post_margin")).toBe(6_500);
    expect(reserveTokens(10_000, "post_margin", 50)).toBe(3_750);
    expect(HUB_MARGIN_PERCENT).toBe(HUB_DEFAULT_MARGIN_PERCENT);
  });
});

describe("contract: the reservation covers what the usage bills (hub 5f62bfb)", () => {
  const costs = [1, 3, 4, 999, 10_000, 363_800, 1_234_567];

  it("pre_margin against a hub with 5f62bfb: reserved = billed, give or take rounding", () => {
    for (const cost of costs) {
      const reserved = hubReserve(reserveTokens(cost, "pre_margin"), HUB_DEFAULT_MARGIN_PERCENT, "5f62bfb");
      const billed = hubBillableTokens(cost, HUB_DEFAULT_MARGIN_PERCENT);
      expect(reserved).toBeGreaterThanOrEqual(billed);
      expect(reserved - billed).toBeLessThanOrEqual(3); // two ceilings instead of one
    }
  });

  it("post_margin against a hub with a5733df alone: reserved = billed", () => {
    for (const cost of costs)
      expect(hubReserve(reserveTokens(cost, "post_margin"), HUB_DEFAULT_MARGIN_PERCENT, "a5733df")).toBe(
        hubBillableTokens(cost, HUB_DEFAULT_MARGIN_PERCENT),
      );
  });

  it("the wrong basis is off by the margin either way", () => {
    const cost = 1_000_000;
    const billed = hubBillableTokens(cost, HUB_DEFAULT_MARGIN_PERCENT);
    // post_margin at a 5f62bfb hub: the margin twice, 2.6× too much.
    expect(hubReserve(reserveTokens(cost, "post_margin"), 160, "5f62bfb") / billed).toBeCloseTo(2.6, 2);
    // pre_margin at an a5733df hub: no margin, 2.6× too little.
    expect(billed / hubReserve(reserveTokens(cost, "pre_margin"), 160, "a5733df")).toBeCloseTo(2.6, 2);
  });
});

describe("voice streams reserve on the configured basis", () => {
  const admitsFor = async (reserveBasis: ReserveBasis) => {
    const admits: { est_tokens: number }[] = [];
    const hub = {
      admit: async (b: { est_tokens: number }) => {
        admits.push(b);
        return { allowed: true, reservation_id: "r1", balance: { unlimited: false, remaining: 1e9 } };
      },
      settle: async () => ({ ok: true }),
    } as unknown as Pick<HubClient, "admit" | "settle">;
    const usage = new HubStreamUsage({
      hub,
      prices: loadPrices(),
      model: "gpt-realtime-2.1-mini",
      now: () => 0,
      reserveSeconds: 600,
      reserveBasis,
    });
    await usage.admit({ owner: "u1", kind: "voice.seconds", class: "stream", sourceId: "vs_1" });
    await usage.keepAlive({ owner: "u1", admissionId: "r1", sourceId: "vs_1" });
    return admits.map((a) => a.est_tokens);
  };
  const cost = voiceSecondsCostMicros(loadPrices(), "gpt-realtime-2.1-mini", 600);

  it.each(["pre_margin", "post_margin"] as const)("%s: admit and keep-alive", async (basis) => {
    expect(await admitsFor(basis)).toEqual([reserveTokens(cost, basis), reserveTokens(cost, basis)]);
  });
});
