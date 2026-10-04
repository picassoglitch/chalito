import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceReporter, desktopActive, type PresenceSignals } from "../src/lib/presence.js";

const here: PresenceSignals = { active: true, locked: false, fullscreen: false, dnd: false };
const away: PresenceSignals = { ...here, active: false };

describe("desktop presence", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("desktopActive: present unless idle, locked or DND; fullscreen still counts", () => {
    expect(desktopActive(here)).toBe(true);
    expect(desktopActive({ ...here, fullscreen: true })).toBe(true);
    expect(desktopActive(away)).toBe(false);
    expect(desktopActive({ ...here, locked: true })).toBe(false);
    expect(desktopActive({ ...here, dnd: true })).toBe(false);
  });

  it("debounces: quick to report active, slow to report inactive, blips never write", () => {
    const sent: boolean[] = [];
    const r = new PresenceReporter(async (p) => void sent.push(p.desktopActive), {
      activateDebounceMs: 1_000,
      deactivateDebounceMs: 15_000,
      heartbeatMs: 10_000_000, // heartbeats have their own test
    });
    r.update(here);
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([true]);
    // A 10 s idle blip: no write.
    r.update(away);
    vi.advanceTimersByTime(10_000);
    r.update(here);
    vi.advanceTimersByTime(20_000);
    expect(sent).toEqual([true]);
    // Really away: one write after the longer debounce.
    r.update(away);
    vi.advanceTimersByTime(15_000);
    expect(sent).toEqual([true, false]);
    // Repeated identical signals don't restart the timer or write again.
    for (let i = 0; i < 10; i++) r.update(away);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([true, false]);
  });

  it("heartbeats while active so last_seen_at stays under 2 min, and stops when inactive", () => {
    const sent: boolean[] = [];
    const r = new PresenceReporter(async (p) => void sent.push(p.desktopActive), {
      activateDebounceMs: 0,
      deactivateDebounceMs: 0,
      heartbeatMs: 45_000,
    });
    r.update(here);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(100_000);
    expect(sent).toEqual([true, true, true]);
    r.update(away);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(200_000);
    expect(sent).toEqual([true, true, true, false]);
  });

  it("stop() reports inactive once and cancels pending writes; sink errors don't throw", async () => {
    const sent: boolean[] = [];
    const errors: unknown[] = [];
    let fail = false;
    const r = new PresenceReporter(
      async (p) => {
        if (fail) throw new Error("ipc down");
        sent.push(p.desktopActive);
      },
      { activateDebounceMs: 0, onError: (e) => errors.push(e) },
    );
    r.update(here);
    vi.advanceTimersByTime(0);
    fail = true;
    vi.advanceTimersByTime(45_000);
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    fail = false;
    r.update(away);
    await r.stop();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([true, false]);
    expect(r.reported).toBe(false);
  });
});
