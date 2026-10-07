import { describe, expect, it } from "vitest";
import { deviceLimitFor, inviteTtlMs, roomLimitsFor } from "../src/rooms/limits.js";

describe("room limits from plans.yaml", () => {
  it("map hub tiers and Solo tiers to the plan's inclusions", () => {
    expect(roomLimitsFor("free")).toEqual({ rooms: 1, membersPerRoom: 4 }); // free → lite (owner 2026-10-06)
    expect(roomLimitsFor("pro")).toEqual({ rooms: 5, membersPerRoom: 8 }); // pro → standard
    expect(roomLimitsFor("vip")).toEqual({ rooms: 10, membersPerRoom: 20 }); // vip → plus
    expect(roomLimitsFor("lite")).toEqual({ rooms: 1, membersPerRoom: 4 });
    expect(roomLimitsFor("heavy")).toEqual({ rooms: 25, membersPerRoom: 50 });
    expect(roomLimitsFor("bundle_8")).toEqual(roomLimitsFor("lite")); // a bundle mirrors its tier
  });
  it("fail closed for unknown or missing tiers", () => {
    for (const t of ["nope", "", null, undefined]) {
      expect(roomLimitsFor(t)).toEqual({ rooms: 0, membersPerRoom: 0 });
      expect(deviceLimitFor(t)).toBe(0);
    }
  });
  it("computer caps: Gratis 1 (its hub cap under Lite's 2), Pro 5, VIP 10", () => {
    expect(deviceLimitFor("free")).toBe(1);
    expect(deviceLimitFor("lite")).toBe(2);
    expect(deviceLimitFor("pro")).toBe(5);
    expect(deviceLimitFor("vip")).toBe(10);
  });
  it("read the invite TTL from rooms.yaml", () => {
    expect(inviteTtlMs()).toBe(7 * 86_400_000);
  });
});
