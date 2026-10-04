import { describe, expect, it } from "vitest";
import { inviteTtlMs, roomLimitsFor } from "../src/rooms/limits.js";

describe("room limits from plans.yaml", () => {
  it("map hub tiers and Solo tiers to the plan's inclusions", () => {
    expect(roomLimitsFor("pro")).toEqual({ rooms: 5, membersPerRoom: 8 }); // pro → standard
    expect(roomLimitsFor("vip")).toEqual({ rooms: 10, membersPerRoom: 20 }); // vip → plus
    expect(roomLimitsFor("lite")).toEqual({ rooms: 1, membersPerRoom: 4 });
    expect(roomLimitsFor("heavy")).toEqual({ rooms: 25, membersPerRoom: 50 });
    expect(roomLimitsFor("bundle_8")).toEqual(roomLimitsFor("lite")); // a bundle mirrors its tier
  });
  it("fail closed for free, unknown or missing tiers", () => {
    for (const t of ["free", "nope", "", null, undefined])
      expect(roomLimitsFor(t)).toEqual({ rooms: 0, membersPerRoom: 0 });
  });
  it("read the invite TTL from rooms.yaml", () => {
    expect(inviteTtlMs()).toBe(7 * 86_400_000);
  });
});
