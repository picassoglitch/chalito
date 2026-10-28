import { describe, expect, it } from "vitest";
import { AWAY_AFTER_MS, DROWSY_AFTER_MS, IdlePoll, restFromIdle, wokeUp } from "../src/pet/sleep.js";

describe("pet sleep follows the person, not the clock", () => {
  it("awake while used, drowsy after a few idle minutes, asleep when away", () => {
    expect(restFromIdle(0)).toBe("awake");
    expect(restFromIdle(DROWSY_AFTER_MS - 1)).toBe("awake");
    expect(restFromIdle(DROWSY_AFTER_MS)).toBe("drowsy");
    expect(restFromIdle(AWAY_AFTER_MS - 1)).toBe("drowsy");
    expect(restFromIdle(AWAY_AFTER_MS)).toBe("away");
    expect(restFromIdle(Number.MAX_SAFE_INTEGER)).toBe("away");
  });

  it("drowsy after 5 idle minutes, asleep after 15 (owner, 2026-10-26)", () => {
    expect(DROWSY_AFTER_MS).toBe(5 * 60_000);
    expect(AWAY_AFTER_MS).toBe(15 * 60_000);
  });

  it("wakes (once) when the person is back", () => {
    expect(wokeUp("away", "awake")).toBe(true);
    expect(wokeUp("drowsy", "awake")).toBe(true);
    expect(wokeUp("awake", "awake")).toBe(false);
    expect(wokeUp("awake", "drowsy")).toBe(false);
  });
});

describe("idle polls", () => {
  it("one at a time: a poll that hasn't answered blocks the next", () => {
    const p = new IdlePoll();
    const a = p.start();
    expect(a).not.toBeNull();
    expect(p.start()).toBeNull();
    expect(p.land(a!)).toBe(true);
    expect(p.start()).not.toBeNull();
  });

  it("a reply that lands after something woke the pet is dropped, and frees the next poll", () => {
    const p = new IdlePoll();
    const a = p.start()!;
    p.invalidate();
    expect(p.start()).toBeNull();
    expect(p.land(a)).toBe(false);
    const b = p.start()!;
    expect(p.land(b)).toBe(true);
  });

  it("a failed poll frees the next one too", () => {
    const p = new IdlePoll();
    const a = p.start()!;
    p.land(a);
    expect(p.start()).not.toBeNull();
  });
});
