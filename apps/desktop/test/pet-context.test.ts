import { describe, expect, it } from "vitest";
import type { NotificationView } from "@chalito/client";
import { inQuietHours, pendingLevel, petContext } from "../src/lib/pet-context.js";

const n = (level: string, state: NotificationView["state"] = "pending"): NotificationView => ({
  nid: `${level}-${state}`,
  level,
  source: "agent",
  urgency: "normal",
  counts: {},
  deepLink: "/",
  state,
  createdAt: 0,
  rev: 1,
});

const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m);

describe("pet context", () => {
  it("the pet signals the highest pending level only", () => {
    expect(pendingLevel([])).toBeNull();
    expect(pendingLevel([n("L1"), n("L3"), n("L2")])).toBe("L3");
    expect(pendingLevel([n("L4", "acked"), n("L2")])).toBe("L2");
    expect(pendingLevel([n("bogus")])).toBeNull();
  });

  it("quiet hours, including windows across midnight", () => {
    const q = { mode: "custom", start: "22:00", end: "08:00" } as const;
    expect(inQuietHours(q, at(23))).toBe(true);
    expect(inQuietHours(q, at(7, 59))).toBe(true);
    expect(inQuietHours(q, at(8))).toBe(false);
    expect(inQuietHours(q, at(12))).toBe(false);
    expect(inQuietHours({ mode: "custom", start: "13:00", end: "14:30" }, at(14, 10))).toBe(true);
    expect(inQuietHours({ ...q, mode: "off" }, at(23))).toBe(false);
    // The default window applies unless turned off.
    expect(inQuietHours({ ...q, mode: "default" }, at(23))).toBe(true);
    expect(inQuietHours({ mode: "custom", start: "nope", end: "08:00" }, at(23))).toBe(false);
  });

  it("combines live data, settings and local state", () => {
    expect(
      petContext(
        { notifications: [n("L2")] },
        { quietHours: { mode: "custom", start: "22:00", end: "08:00" } },
        { dnd: true, fullscreen: false, lowEnergy: false },
        at(23),
      ),
    ).toEqual({ level: "L2", quietHours: true, dnd: true, fullscreen: false, lowEnergy: false });
  });
});
