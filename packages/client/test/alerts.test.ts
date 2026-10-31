import { describe, expect, it } from "vitest";
import { AlertActions, AlertActionsUnavailable } from "../src/alerts.js";

const recorder = (errors: { code: string; message: string }[] = []) => {
  const calls: [string, Record<string, string>][] = [];
  return {
    calls,
    rpc: (fn: string, args: Record<string, string>) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: null, error: errors.shift() ?? null });
    },
  };
};

describe("AlertActions (chalito.notification_action)", () => {
  it("sends seen, waiting on/off and snooze with the right arguments", async () => {
    const db = recorder();
    const a = new AlertActions(db);
    await a.seen("s1");
    await a.waiting("s1", true);
    await a.waiting("s1", false);
    await a.snooze("al_s1_1");
    expect(db.calls).toEqual([
      ["notification_action", { p_action: "seen", p_sid: "s1" }],
      ["notification_action", { p_action: "waiting", p_sid: "s1" }],
      ["notification_action", { p_action: "not_waiting", p_sid: "s1" }],
      ["notification_action", { p_action: "snooze", p_nid: "al_s1_1" }],
    ]);
  });

  it("a database without the function: reported once, then seen stops calling it and actions fail visibly", async () => {
    const db = recorder([{ code: "PGRST202", message: "Could not find the function chalito.notification_action" }]);
    const reports: string[] = [];
    const a = new AlertActions(db, undefined, (m) => reports.push(m));
    await expect(a.seen("s1")).rejects.toBeInstanceOf(AlertActionsUnavailable);
    expect(a.available).toBe(false);
    await a.seen("s2");
    await a.seen("s3");
    await expect(a.waiting("s1", true)).rejects.toBeInstanceOf(AlertActionsUnavailable);
    await expect(a.snooze("n1")).rejects.toBeInstanceOf(AlertActionsUnavailable);
    expect(db.calls).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/notification_action is missing/);
  });

  it("a missing function is asked about again after 10 min (PostgREST's schema cache catches up)", async () => {
    let now = 1_000_000;
    const db = recorder([{ code: "PGRST202", message: "Could not find the function" }]);
    const reports: string[] = [];
    const a = new AlertActions(
      db,
      undefined,
      (m) => reports.push(m),
      () => now,
    );
    await expect(a.seen("s1")).rejects.toBeInstanceOf(AlertActionsUnavailable);
    now += 9 * 60_000;
    await a.seen("s1");
    expect(db.calls).toHaveLength(1);
    now += 60_000;
    expect(a.available).toBe(false);
    const heard: boolean[] = [];
    a.subscribe(() => heard.push(a.available));
    await a.seen("s1");
    // The retry went through: the app hears it, so its buttons come back without waiting for a redraw.
    expect(heard).toEqual([true]);
    expect(a.available).toBe(true);
    await a.waiting("s1", true);
    expect(db.calls).toHaveLength(3);
    expect(reports).toHaveLength(1);
  });

  it("retries a rate-limited call and surfaces a refusal", async () => {
    const db = recorder([{ code: "PT429", message: "rate limit" }]);
    await new AlertActions(db, { baseMs: 0, attempts: 3, sleep: async () => undefined }).seen("s1");
    expect(db.calls).toHaveLength(2);
    const refused = recorder([{ code: "42501", message: "chalito: not allowed" }]);
    await expect(new AlertActions(refused).seen("s1")).rejects.toThrow(/not allowed/);
  });
});
