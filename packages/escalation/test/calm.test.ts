import { describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { sidOf } from "../src/ladder.js";
import type { EscalationEvent } from "../src/types.js";
import { MIN, NOON_MX, item, prefsAll, simulate, timeline, type Logged } from "./sim.js";

// Calmer alerts, from Alux by Omar (homiomar): seen, one re-nudge, "Esperando a alguien", snooze.
const at = (min: number) => NOON_MX + min * MIN;
const step = (min: number, event: EscalationEvent) => ({ at: at(min), event });
const notify = (min: number, over = {}) => step(min, { type: "notify", item: item({ createdAt: at(min), ...over }) });
const desktop = (log: Logged[], nid = "n1") =>
  log.flatMap((l) =>
    l.action.type === "send" && l.action.channel === "desktop" && l.action.nid === nid
      ? [[Math.round((l.at - NOON_MX) / MIN), l.action.level]]
      : [],
  );

describe("agent alerts (stuck / stalled)", () => {
  const alert = (min: number, level: "L1" | "L2") =>
    notify(min, { source: "agent_alert", level, coalesceKey: "alert:s1:1", urgency: "normal" });

  it("stuck (L2): a push, a second at +5, never WhatsApp, a call or SMS", () => {
    const { sends, history } = simulate(prefsAll(), [alert(0, "L2")]);
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
    ]);
    expect(history.ladders[0]!.state).toBe("done");
  });

  it("stalled (L1): one push", () => {
    expect(timeline(simulate(prefsAll(), [alert(0, "L1")]).sends, NOON_MX)).toEqual([[0, "push"]]);
  });

  it("the same turn's second alert coalesces into the first ladder (fires once)", () => {
    const { sends, history } = simulate(prefsAll(), [alert(0, "L1"), alert(1, "L2")]);
    expect(history.ladders).toHaveLength(1);
    expect(history.ladders[0]!.item.level).toBe("L2");
    expect(timeline(sends, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
    ]);
  });
});

describe("seen (opening the session in the app)", () => {
  it("stops the ladder, then one gentle desktop re-nudge 2 h later, capped at L1", () => {
    const { log, history } = simulate(prefsAll(), [notify(0), step(1, { type: "seen", sid: "s1" })]);
    // Before: push at 0. After the look: no phone channel ever again.
    expect(timeline(log, NOON_MX)).toEqual([[0, "push"]]);
    expect(desktop(log)).toEqual([
      [0, "L1"],
      [121, "L1"],
    ]);
    expect(history.ladders[0]).toMatchObject({ state: "pending", renudged: true, nextAt: null });
    expect(history.ladders[0]!.hold).toBeUndefined();
  });

  it("an L4 item's re-nudge is still L1: the pet never takes focus for it", () => {
    const { log } = simulate(prefsAll(), [notify(0, { level: "L4" }), step(12, { type: "seen", sid: "s1" })]);
    expect(desktop(log).at(-1)).toEqual([132, "L1"]);
  });

  it("one re-nudge per session, however many of its alerts were seen", () => {
    const alert = (min: number, turn: number) =>
      notify(min, {
        nid: `al_s1_${turn}`,
        source: "agent_alert",
        level: "L2",
        urgency: "normal",
        coalesceKey: `alert:s1:${turn}`,
        sid: "s1",
      });
    const { log, history } = simulate(prefsAll(), [
      alert(0, 1),
      alert(1, 2),
      alert(2, 3),
      alert(3, 4),
      step(30, { type: "seen", sid: "s1" }),
    ]);
    const later = log.filter((l) => l.at > at(30) && l.action.type === "send" && l.action.channel === "desktop");
    expect(later).toHaveLength(1);
    expect(later[0]!.at).toBe(at(150));
    expect(history.ladders.filter((l) => l.renudged)).toHaveLength(1);
    expect(history.ladders.filter((l) => l.state === "acked")).toHaveLength(3);
  });

  it("the session's re-nudge comes from its most urgent alert, whichever rests end first", () => {
    const { log, history } = simulate(prefsAll(), [
      notify(0, { nid: "t_s1", source: "turn_finished", level: "L1", urgency: "low", coalesceKey: "turn:s1" }),
      notify(1, {
        nid: "al_s1_1",
        source: "agent_alert",
        level: "L2",
        urgency: "normal",
        coalesceKey: "alert:s1:1",
        sid: "s1",
      }),
      step(30, { type: "seen", sid: "s1" }),
    ]);
    const renudges = log.filter((l) => l.at > at(30) && l.action.type === "send" && l.action.channel === "desktop");
    expect(renudges.map((l) => (l.action.type === "send" ? l.action.nid : ""))).toEqual(["al_s1_1"]);
    expect(history.ladders.find((l) => l.item.nid === "t_s1")!.state).toBe("acked");
  });

  it("re-nudges once: the next look acks it for good", () => {
    const { log, history } = simulate(prefsAll(), [
      notify(0),
      step(1, { type: "seen", sid: "s1" }),
      step(200, { type: "seen", sid: "s1" }),
    ]);
    expect(desktop(log).filter(([m]) => (m as number) > 1)).toEqual([[121, "L1"]]);
    expect(history.ladders[0]).toMatchObject({ state: "acked", ackedVia: "app" });
  });

  it("covers every alert of that session (a finished one too) and no other session's", () => {
    const { history } = simulate(
      prefsAll(),
      [
        notify(0, { nid: "q", coalesceKey: "session:s1" }),
        notify(0, { nid: "t", source: "turn_finished", level: "L1", coalesceKey: "turn:s1" }),
        notify(0, { nid: "other", coalesceKey: "session:s2", deepLink: "/s/s2" }),
        step(30, { type: "seen", sid: "s1" }),
      ],
      { until: at(31) },
    );
    const by = (nid: string) => history.ladders.find((l) => l.item.nid === nid)!;
    expect(by("q").hold?.kind).toBe("seen");
    expect(by("t").hold?.kind).toBe("seen");
    expect(by("other").state).toBe("done");
    expect(by("other").hold).toBeUndefined();
  });

  it("waits behind fresh alerts: the re-nudge goes out once nothing new is pending", () => {
    const { log } = simulate(prefsAll(), [
      notify(0),
      step(1, { type: "seen", sid: "s1" }),
      // Another session's question lands just before the re-nudge; its ladder runs until +135.
      notify(115, { nid: "n2", coalesceKey: "session:s2", deepLink: "/s/s2" }),
    ]);
    expect(desktop(log).filter(([m]) => (m as number) > 1)).toEqual([[136, "L1"]]);
  });

  it("news on a session you only looked at alerts again, keeping the rung spacing", () => {
    const { log } = simulate(prefsAll(), [notify(0), step(1, { type: "seen", sid: "s1" }), notify(31, { nid: "n1b" })]);
    // The rung clock moved by the 30 min of rest: the +5 re-push lands at +35.
    expect(timeline(log, NOON_MX).slice(0, 3)).toEqual([
      [0, "push"],
      [35, "push"],
      [40, "whatsapp"],
    ]);
  });

  it("news after the re-nudge keeps the rung spacing (no burst of overdue rungs)", () => {
    const { log } = simulate(prefsAll(), [
      notify(0),
      step(1, { type: "seen", sid: "s1" }),
      notify(200, { nid: "n1b" }),
    ]);
    // The clock restarts at the news: the +5 re-push lands at +205, then the usual spacing.
    expect(timeline(log, NOON_MX)).toEqual([
      [0, "push"],
      [205, "push"],
      [210, "whatsapp"],
      [215, "call"],
      [220, "sms"],
    ]);
  });

  it("a snoozed alert resuming in quiet hours still holds the phone until 07:00", () => {
    const night = Date.UTC(2026, 9, 6, 4, 50); // 22:50 in Mexico City
    const m = (min: number) => night + min * MIN;
    const { log } = simulate(prefsAll(), [
      { at: m(0), event: { type: "notify", item: item({ createdAt: m(0) }) } },
      { at: m(2), event: { type: "snooze_alert", nid: "n1" } },
    ]);
    const phone = log.filter((l) => l.action.type === "send" && l.action.channel !== "desktop" && l.at > m(0));
    const sevenAm = Date.UTC(2026, 9, 6, 13, 0);
    expect(phone.every((l) => l.at >= sevenAm)).toBe(true);
    expect(log.some((l) => l.action.type === "suppressed" && l.action.reason === "quiet_hours")).toBe(true);
  });

  it("leaves approvals alone: they expire in minutes and still need an answer", () => {
    const { log, history } = simulate(prefsAll(), [
      notify(0, {
        nid: "a1",
        source: "approval",
        coalesceKey: "approval:a1",
        deepLink: "/a/a1",
        sid: "s1",
        approvalExpiresAt: at(10),
      }),
      step(1, { type: "seen", sid: "s1" }),
    ]);
    expect(history.ladders[0]!.state).toBe("expired");
    expect(
      log.some(
        (l) =>
          l.at === at(10) &&
          l.action.type === "send" &&
          "notice" in l.action.payload &&
          l.action.payload.notice === "approval_expired",
      ),
    ).toBe(true);
    expect(timeline(log, NOON_MX)).toEqual([
      [0, "push"],
      [3, "whatsapp"],
      [5, "push"],
      [6, "call"],
      [8, "sms"],
      [10, "push"],
    ]);
  });

  it("a finished ladder that was seen still alerts the phone on later news, and blocks no one", () => {
    const q = (min: number, nid: string, sid = "s1") =>
      notify(min, { nid, level: "L3", coalesceKey: `session:${sid}`, deepLink: `/s/${sid}` });
    const { log } = simulate(prefsAll(), [
      q(0, "n1"),
      step(60, { type: "seen", sid: "s1" }),
      q(200, "n2"),
      q(300, "n3", "s2"),
      step(330, { type: "seen", sid: "s2" }),
    ]);
    expect(timeline(log, NOON_MX).filter(([m]) => (m as number) < 300)).toEqual([
      [0, "push"],
      [5, "push"],
      [10, "whatsapp"],
      [200, "push"],
      [205, "push"],
      [210, "whatsapp"],
    ]);
    // s2's re-nudge isn't held back by s1's finished ladders.
    expect(desktop(log, "n3").at(-1)).toEqual([450, "L1"]);
  });

  it("a stale tick from an earlier rest never releases a newer one early", () => {
    const h = simulate(prefsAll(), [notify(0, { level: "L1" }), step(1, { type: "seen", sid: "s1" })], {
      until: at(2),
    });
    const l = h.history.ladders[0]!;
    expect(l.hold?.kind).toBe("seen");
    // The old tick for this nid fires at +60, before the rest's +121.
    expect(decide({ type: "tick", nid: "n1" }, prefsAll(), { desktopActive: false }, h.history, at(60))).toEqual([]);
  });
});

describe("Esperando a alguien", () => {
  const approval = (min: number) =>
    notify(min, {
      nid: "a1",
      source: "approval",
      coalesceKey: "approval:a1",
      deepLink: "/a/a1",
      sid: "s1",
      approvalExpiresAt: at(min + 10),
    });

  it("an approval answered while parked stays answered after the undo", () => {
    const { log, history } = simulate(prefsAll(), [
      approval(0),
      step(1, { type: "waiting", sid: "s1", on: true }),
      step(2, { type: "ack", via: "app", nid: "a1" }),
      step(3, { type: "waiting", sid: "s1", on: false }),
    ]);
    expect(timeline(log, NOON_MX)).toEqual([[0, "push"]]);
    expect(history.ladders[0]).toMatchObject({ state: "acked" });
    expect(history.ladders[0]!.waitingSince).toBeUndefined();
  });

  it("an approval that expired while parked stays expired after the undo", () => {
    const { log, history } = simulate(prefsAll(), [
      approval(0),
      step(1, { type: "waiting", sid: "s1", on: true }),
      step(10, { type: "approval_expired", nid: "a1" }),
      step(11, { type: "waiting", sid: "s1", on: false }),
    ]);
    expect(timeline(log, NOON_MX)).toEqual([[0, "push"]]);
    expect(history.ladders[0]!.state).toBe("expired");
  });

  it("parks the session's alerts with no re-nudge, until the session changes again", () => {
    const { log, history } = simulate(prefsAll(), [
      notify(0),
      step(1, { type: "waiting", sid: "s1", on: true }),
      // Hours later the session asks something new: a fresh ladder.
      notify(300, { nid: "n2" }),
    ]);
    expect(desktop(log, "n1")).toEqual([[0, "L1"]]);
    expect(timeline(log, NOON_MX)[1]).toEqual([300, "push"]);
    expect(history.ladders[0]).toMatchObject({ state: "done" });
    expect(history.ladders[0]!.item.nid).toBe("n2");
  });

  it("undo resumes where it was, the rung clock shifted by the parked time", () => {
    const { log } = simulate(prefsAll(), [
      notify(0),
      step(1, { type: "waiting", sid: "s1", on: true }),
      step(61, { type: "waiting", sid: "s1", on: false }),
    ]);
    expect(timeline(log, NOON_MX).slice(0, 2)).toEqual([
      [0, "push"],
      [65, "push"],
    ]);
  });
});

describe("snooze one alert (30 min)", () => {
  it("is quiet 30 min, then resumes with the rungs' spacing", () => {
    const { log } = simulate(prefsAll(), [notify(0), step(2, { type: "snooze_alert", nid: "n1" })]);
    expect(timeline(log, NOON_MX)).toEqual([
      [0, "push"],
      [35, "push"],
      [40, "whatsapp"],
      [45, "call"],
      [50, "sms"],
    ]);
  });

  it("a finished alert (still pending in the app) can be postponed too, and comes back as it was", () => {
    const { history } = simulate(
      prefsAll(),
      [
        notify(0, { source: "turn_finished", level: "L1", coalesceKey: "turn:s1" }),
        step(5, { type: "snooze_alert", nid: "n1" }),
      ],
      { until: at(20) },
    );
    expect(history.ladders[0]).toMatchObject({ state: "snoozed", nextAt: at(35) });
    const back = simulate(prefsAll(), [
      notify(0, { source: "turn_finished", level: "L1", coalesceKey: "turn:s1" }),
      step(5, { type: "snooze_alert", nid: "n1" }),
    ]);
    expect(back.history.ladders[0]!.state).toBe("done");
    expect(timeline(back.log, NOON_MX)).toEqual([[0, "push"]]);
  });

  it("news on a finished alert you postponed stays quiet until the 30 min are up", () => {
    const alert = (min: number, nid: string) =>
      notify(min, { nid, source: "agent_alert", level: "L2", coalesceKey: "alert:s1", urgency: "normal" });
    const { log, history } = simulate(prefsAll(), [
      alert(0, "n1"),
      step(6, { type: "snooze_alert", nid: "n1" }),
      alert(10, "n2"),
    ]);
    expect(timeline(log, NOON_MX)).toEqual([
      [0, "push"],
      [5, "push"],
    ]);
    expect(history.ladders).toHaveLength(1);
    expect(history.ladders[0]!.state).toBe("done");
  });

  it("an update while snoozed stays quiet", () => {
    const { log } = simulate(prefsAll(), [
      notify(0),
      step(2, { type: "snooze_alert", nid: "n1" }),
      notify(10, { counts: { approvals: 0, questions: 2, messages: 0, mesas: 0 } }),
    ]);
    expect(timeline(log, NOON_MX)[1]).toEqual([35, "push"]);
    expect(desktop(log).some(([m]) => m === 10)).toBe(false);
  });
});

describe("ack by session", () => {
  it("acks only the named sources of that session (a new prompt leaves its approval alone)", () => {
    const h = simulate(
      prefsAll(),
      [
        notify(0, { nid: "al", source: "agent_alert", level: "L2", coalesceKey: "alert:s1:1" }),
        notify(0, {
          nid: "ap",
          source: "approval",
          coalesceKey: "approval:ap",
          deepLink: "/a/ap",
          sid: "s1",
          approvalExpiresAt: at(10),
        }),
        step(1, { type: "ack", via: "app", sid: "s1", sources: ["agent_alert", "session_question"] }),
      ],
      { until: at(2) },
    );
    const by = (nid: string) => h.history.ladders.find((l) => l.item.nid === nid)!;
    expect(by("al").state).toBe("acked");
    expect(by("ap").state).toBe("pending");
  });

  it("sidOf reads the item's sid or its /s/ link", () => {
    expect(sidOf(item({ deepLink: "/s/abc" }))).toBe("abc");
    expect(sidOf(item({ deepLink: "/a/x", sid: "s9" }))).toBe("s9");
    expect(sidOf(item({ deepLink: "/r/room" }))).toBeUndefined();
  });

  it("an event for an unknown session does nothing", () => {
    expect(
      decide({ type: "seen", sid: "nope" }, prefsAll(), { desktopActive: false }, { ladders: [], sent: [] }, NOON_MX),
    ).toEqual([]);
  });
});
