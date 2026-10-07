import { describe, expect, it } from "vitest";
import { loadPlans } from "@chalito/config";
import { hubTierOf, localMonthKey, localMonthStart, monthlyLimit } from "../src/caps.js";

const plans = loadPlans();

describe("monthly caps", () => {
  it("the month starts at local midnight on the 1st, in the user's time zone", () => {
    const now = Date.UTC(2026, 9, 15, 12); // Oct 15
    expect(new Date(localMonthStart(now, "America/Mexico_City")).toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(new Date(localMonthStart(now, "Asia/Tokyo")).toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // Late on Oct 31 in Mexico City is already November in UTC, but still October locally.
    const lateOct = Date.UTC(2026, 10, 1, 4); // Oct 31 22:00 in Mexico City
    expect(localMonthKey(lateOct, "America/Mexico_City")).toBe("2026_10");
    expect(localMonthKey(lateOct, "UTC")).toBe("2026_11");
    // New York across the DST change (Nov 1, 2026).
    expect(new Date(localMonthStart(Date.UTC(2026, 10, 20), "America/New_York")).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
  });

  it("limits come from the plan; unset or no plan allows nothing", () => {
    const at = { uid: "u1", comped: false, now: 1 };
    expect(monthlyLimit(plans, { ...at, hubTier: "pro" }, "call")).toBe(30);
    expect(monthlyLimit(plans, { ...at, hubTier: "PRO" }, "voice")).toBe(120);
    expect(monthlyLimit(plans, { ...at, hubTier: "vip" }, "sms")).toBe(30);
    expect(monthlyLimit(plans, { ...at, hubTier: "pro" }, "sms")).toBe(0);
    expect(monthlyLimit(plans, { ...at, hubTier: "free" }, "whatsapp")).toBe(0); // hub cap under Lite's 100
    expect(monthlyLimit(plans, { ...at, hubTier: "gold" }, "whatsapp")).toBe(0);
    expect(monthlyLimit(plans, { ...at, hubTier: null, comped: true }, "call")).toBe(300);
    expect([hubTierOf("Pro"), hubTierOf("nope"), hubTierOf(null)]).toEqual(["pro", null, null]);
  });
});
