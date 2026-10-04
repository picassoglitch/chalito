import { describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { inQuietHours } from "../src/time.js";
import { HOUR, MIN, NOON_MX, item, prefsAll, simulate, timeline } from "./sim.js";

const notify = (at: number, over = {}) => ({
  at,
  event: { type: "notify" as const, item: item({ createdAt: at, ...over }) },
});

describe("ladders", () => {
  it("an L4 item climbs push → re-push → WhatsApp → call → SMS (last rung)", () => {
    const { sends, history } = simulate(prefsAll(), [notify(NOON_MX)]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
      [15, "call"],
      [20, "sms"],
    ]);
    expect(history.ladders[0]!.state).toBe("done");
  });

  it("an item only climbs to its own level", () => {
    expect(timeline(simulate(prefsAll(), [notify(NOON_MX, { level: "L2" })]).sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
    ]);
    expect(timeline(simulate(prefsAll(), [notify(NOON_MX, { level: "L3" })]).sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
    ]);
  });

  it("L0 is ambient: the desktop only", () => {
    const { sends } = simulate(prefsAll(), [notify(NOON_MX, { level: "L0" })]);
    expect(sends.map((s) => (s.action.type === "send" ? [s.action.channel, s.action.level] : null))).toEqual([
      ["desktop", "L0"],
    ]);
  });

  it("every rung also tells the desktop, at the rung's level", () => {
    const { sends } = simulate(prefsAll(), [notify(NOON_MX, { level: "L3" })]);
    const desktop = sends.filter((s) => s.action.type === "send" && s.action.channel === "desktop");
    expect(desktop.map((s) => (s.action.type === "send" ? s.action.level : ""))).toEqual(["L1", "L2", "L3"]);
  });

  it("SMS is off by default for MX numbers, on when enabled", () => {
    const mx = prefsAll({ phone: { e164: "+525512345678", country: "MX", verified: true, chargesNoticeAckAt: 1 } });
    const off = simulate(mx, [notify(NOON_MX)]);
    expect(timeline(off.sends, NOON_MX).map((x) => x[1])).not.toContain("sms");
    expect(
      off.log.some(
        (l) => l.action.type === "suppressed" && l.action.channel === "sms" && l.action.reason === "disabled",
      ),
    ).toBe(true);
    const on = simulate({ ...mx, sms: { enabled: true } }, [notify(NOON_MX)]);
    expect(timeline(on.sends, NOON_MX).at(-1)).toEqual([20, "sms"]);
  });

  it("channels need opt-in, a verified phone and (calls, SMS) the charges notice", () => {
    const reasons = (prefs: Parameters<typeof simulate>[0]) =>
      simulate(prefs, [notify(NOON_MX)])
        .log.filter((l) => l.action.type === "suppressed")
        .map((l) => (l.action.type === "suppressed" ? `${l.action.channel}:${l.action.reason}` : ""));
    expect(reasons(prefsAll({ whatsapp: { optIn: false }, calls: { enabled: false } }))).toEqual([
      "whatsapp:disabled",
      "call:disabled",
    ]);
    expect(
      reasons(prefsAll({ phone: { e164: "+14155550100", country: "US", verified: false, chargesNoticeAckAt: 1 } })),
    ).toEqual(["whatsapp:no_verified_phone", "call:no_verified_phone", "sms:no_verified_phone"]);
    expect(
      reasons(prefsAll({ phone: { e164: "+14155550100", country: "US", verified: true, chargesNoticeAckAt: null } })),
    ).toEqual(["call:no_charges_ack", "sms:no_charges_ack"]);
  });
});

describe("tool approvals (clipped to the 10-minute TTL)", () => {
  const approval = (at: number, over = {}) =>
    notify(at, { source: "approval", coalesceKey: "approval:a1", approvalExpiresAt: at + 10 * MIN, ...over });

  it("push, WhatsApp +3, re-push +5, call +6, SMS +8, then an L1 'Expiró: denegada' at +10", () => {
    const { sends, history } = simulate(prefsAll(), [approval(NOON_MX)]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [3, "whatsapp"],
      [5, "push"],
      [6, "call"],
      [8, "sms"],
      [10, "push"],
    ]);
    const last = sends.at(-1)!.action;
    expect(last.type === "send" && last.channel === "push" && last.payload).toMatchObject({
      level: "L1",
      notice: "approval_expired",
    });
    expect(history.ladders[0]!.state).toBe("expired");
  });

  it("rungs pushed past the expiry by a hold are dropped", () => {
    const { sends } = simulate(prefsAll(), [approval(NOON_MX)], { presence: { desktopActive: true } });
    expect(timeline(sends, NOON_MX)).toEqual([
      [2, "push"],
      [5, "whatsapp"],
      [7, "push"],
      [8, "call"],
      [10, "push"],
    ]);
    expect(sends.some((s) => s.action.type === "send" && s.action.channel === "sms")).toBe(false);
  });

  it("an approval_expired event ends the ladder at once", () => {
    const { sends } = simulate(prefsAll(), [
      approval(NOON_MX),
      { at: NOON_MX + 4 * MIN, event: { type: "approval_expired", nid: "n1" } },
    ]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [3, "whatsapp"],
      [4, "push"],
    ]);
  });
});

describe("presence first", () => {
  it("while the desktop is active, phone channels wait 2 minutes and the ladder keeps its spacing", () => {
    const { sends } = simulate(prefsAll(), [notify(NOON_MX)], { presence: { desktopActive: true } });
    expect(sends[0]!.action).toMatchObject({ channel: "desktop" });
    expect(sends[0]!.at).toBe(NOON_MX);
    expect(timeline(sends, NOON_MX)).toEqual([
      [2, "push"],
      [7, "push"],
      [12, "whatsapp"],
      [17, "call"],
      [22, "sms"],
    ]);
  });
});

describe("quiet hours", () => {
  const night = Date.UTC(2026, 9, 6, 5, 30); // 23:30 in Mexico City
  const seven = Date.UTC(2026, 9, 6, 13, 0); // 07:00

  it("hold phone channels until 07:00 local, then the ladder runs with its spacing", () => {
    expect(inQuietHours(night, "America/Mexico_City", { start: "23:00", end: "07:00" })).toBe(true);
    const { sends } = simulate(prefsAll(), [notify(night, { level: "L3" })]);
    expect(timeline(sends, seven)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
    ]);
    expect(sends[0]!.at).toBe(night); // the desktop is told at once
  });

  it("an allowlisted L4 item goes through at night, calls included", () => {
    const prefs = prefsAll({ l4QuietOverride: ["security"] });
    const { sends } = simulate(prefs, [notify(night, { source: "security", coalesceKey: "security:x" })]);
    expect(timeline(sends, night)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
      [15, "call"],
      [20, "sms"],
    ]);
  });

  it("the allowlist doesn't cover other sources or lower levels", () => {
    const prefs = prefsAll({ l4QuietOverride: ["security"] });
    const other = simulate(prefs, [notify(night)]);
    expect(
      other.sends.filter((s) => s.at < seven).every((s) => s.action.type === "send" && s.action.channel === "desktop"),
    ).toBe(true);
    const l3 = simulate(prefs, [notify(night, { source: "security", level: "L3" })]);
    expect(
      l3.sends.filter((s) => s.at < seven).every((s) => s.action.type === "send" && s.action.channel === "desktop"),
    ).toBe(true);
  });

  it("can be turned off (null) or moved", () => {
    expect(timeline(simulate(prefsAll({ quietHours: null }), [notify(night, { level: "L1" })]).sends, night)).toEqual([
      [0, "push"],
    ]);
    expect(
      timeline(
        simulate(prefsAll({ quietHours: { start: "22:00", end: "06:30" } }), [notify(night, { level: "L1" })]).sends,
        seven,
      ),
    ).toEqual([[-30, "push"]]);
  });
});

describe("coalescing", () => {
  it("a notify with the same coalesceKey updates the ladder without restarting it", () => {
    const { sends, history } = simulate(prefsAll(), [
      notify(NOON_MX, { level: "L2" }),
      notify(NOON_MX + 2 * MIN, {
        nid: "n2",
        level: "L3",
        counts: { approvals: 0, questions: 3, messages: 0, mesas: 0 },
      }),
    ]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
    ]);
    expect(history.ladders).toHaveLength(1);
    const wa = sends.find((s) => s.action.type === "send" && s.action.channel === "whatsapp")!.action;
    expect(wa.type === "send" && wa.payload).toMatchObject({ total: 3, linkId: "n1" });
  });

  it("a different coalesceKey opens its own ladder", () => {
    const { history } = simulate(prefsAll(), [
      notify(NOON_MX),
      notify(NOON_MX + MIN, { nid: "n2", coalesceKey: "session:s2" }),
    ]);
    expect(history.ladders).toHaveLength(2);
  });
});

describe("ack anywhere", () => {
  it("cancels every pending step of the acked ladder", () => {
    const { sends, log, history } = simulate(prefsAll(), [
      notify(NOON_MX),
      { at: NOON_MX + 11 * MIN, event: { type: "ack", via: "whatsapp", nid: "n1" } },
    ]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
    ]);
    expect(log.some((l) => l.action.type === "cancel" && l.at === NOON_MX + 11 * MIN)).toBe(true);
    expect(history.ladders[0]).toMatchObject({ state: "acked", ackedVia: "whatsapp" });
  });

  it("by coalesceKey or everything at once", () => {
    const two = [notify(NOON_MX), notify(NOON_MX, { nid: "n2", coalesceKey: "session:s2" })];
    const byKey = simulate(prefsAll(), [
      ...two,
      { at: NOON_MX + MIN, event: { type: "ack", via: "app", coalesceKey: "session:s2" } },
    ]);
    expect(byKey.history.ladders.map((l) => l.state)).toEqual(["done", "acked"]);
    const all = simulate(prefsAll(), [...two, { at: NOON_MX + MIN, event: { type: "ack", via: "app", all: true } }]);
    expect(all.history.ladders.map((l) => l.state)).toEqual(["acked", "acked"]);
    expect(timeline(all.sends, NOON_MX)).toEqual([
      [0, "push"],
      [0, "push"],
    ]);
  });
});

describe("snooze (DTMF 2)", () => {
  it("re-calls after 10 minutes and keeps the rest of the ladder's spacing", () => {
    const { sends } = simulate(prefsAll(), [
      notify(NOON_MX),
      { at: NOON_MX + 16 * MIN, event: { type: "snooze", nid: "n1" } },
    ]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
      [15, "call"],
      [26, "call"],
      [31, "sms"],
    ]);
  });

  it("for a Mesa, re-calls one minute before it starts", () => {
    const starts = NOON_MX + 30 * MIN;
    const { sends } = simulate(prefsAll(), [
      notify(NOON_MX, { source: "mesa_starting", coalesceKey: "mesa:m1", mesaStartsAt: starts }),
      { at: NOON_MX + 16 * MIN, event: { type: "snooze", nid: "n1" } },
    ]);
    expect(timeline(sends, NOON_MX)).toContainEqual([29, "call"]);
  });
});

describe("daily caps", () => {
  it("at most 3 calls per local day; the next day starts fresh", () => {
    const items = [0, 1, 2, 3].map((i) => notify(NOON_MX + i * HOUR, { nid: `n${i}`, coalesceKey: `k${i}` }));
    const nextDay = notify(NOON_MX + 24 * HOUR, { nid: "n9", coalesceKey: "k9" });
    const { sends, log } = simulate(prefsAll(), [...items, nextDay]);
    const calls = sends.filter((s) => s.action.type === "send" && s.action.channel === "call");
    expect(calls.map((c) => c.action.type === "send" && c.action.nid)).toEqual(["n0", "n1", "n2", "n9"]);
    expect(
      log.some((l) => l.action.type === "suppressed" && l.action.channel === "call" && l.action.reason === "cap"),
    ).toBe(true);
  });

  it("counts sends already in history", () => {
    const sent = Array.from({ length: 10 }, (_, i) => ({
      nid: `old${i}`,
      channel: "whatsapp" as const,
      at: NOON_MX - HOUR,
    }));
    const ladder = {
      item: item({ level: "L3" }),
      state: "pending" as const,
      step: 2,
      openedAt: NOON_MX - 10 * MIN,
      startedAt: NOON_MX - 10 * MIN,
      nextAt: NOON_MX,
      ackedAt: null,
      ackedVia: null,
    };
    const actions = decide(
      { type: "tick", nid: "n1" },
      prefsAll(),
      { desktopActive: false },
      { ladders: [ladder], sent },
      NOON_MX,
    );
    expect(actions).toContainEqual({ type: "suppressed", nid: "n1", channel: "whatsapp", reason: "cap" });
  });
});

describe("stale and unknown ticks", () => {
  it("do nothing", () => {
    expect(
      decide({ type: "tick", nid: "nope" }, prefsAll(), { desktopActive: false }, { ladders: [], sent: [] }, NOON_MX),
    ).toEqual([]);
  });
});
