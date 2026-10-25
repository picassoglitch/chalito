import { describe, expect, it } from "vitest";
import { ActivityTracker, activityActions, type Activity, type EventLike } from "../src/activity.js";

const msg = (eid: string, t: number, type = "message.assistant", live?: boolean): EventLike => ({
  eid,
  t,
  type,
  ...(live ? { live } : {}),
});

describe("which events reach the pet (ActivityTracker)", () => {
  it("a task started: a new running session, or an idle one running again; not after an answer", () => {
    const tr = new ActivityTracker();
    tr.update([{ sid: "a", state: "idle" }], 0, { now: 1000 });
    expect(tr.update([{ sid: "a", state: "running" }], 0).started).toBe(1);
    expect(tr.update([{ sid: "a", state: "waiting_approval" }], 0).started).toBe(1);
    expect(tr.update([{ sid: "a", state: "running" }], 0).started).toBe(1);
    const a = tr.update(
      [
        { sid: "a", state: "running" },
        { sid: "b", state: "starting", updatedAt: 2000 },
      ],
      0,
    );
    expect(a.started).toBe(2);
    // starting → running is the same start.
    const b = tr.update(
      [
        { sid: "a", state: "running" },
        { sid: "b", state: "running" },
      ],
      0,
    );
    expect(b.started).toBe(2);
  });

  it("a short task first seen already finished still counts as finished", () => {
    const tr = new ActivityTracker();
    tr.update([], 0, { now: 1000 });
    expect(tr.update([{ sid: "a", state: "completed", updatedAt: 1500 }], 0)).toMatchObject({ done: 1, started: 0 });
  });

  it("what loads after the first update but is dated before it (or undated: 0, NaN) isn't news", () => {
    const tr = new ActivityTracker();
    tr.update([], 0, { now: 10_000, events: {}, notifications: [] });
    const a = tr.update(
      [
        { sid: "old", state: "completed", updatedAt: 5000 },
        { sid: "old2", state: "running", updatedAt: 9000 },
        { sid: "zero", state: "running", updatedAt: 0 },
        { sid: "nan", state: "failed", updatedAt: NaN },
        { sid: "none", state: "completed" },
      ],
      0,
      {
        events: { old: [msg("e1", 4000)], nan: [msg("e2", NaN)] },
        notifications: [
          { nid: "n1", state: "pending", createdAt: 3000 },
          { nid: "n2", state: "pending", createdAt: NaN },
          { nid: "n3", state: "pending" },
        ],
      },
    );
    expect(a).toMatchObject({ done: 0, failed: 0, started: 0, messages: 0, alerts: 0 });
  });

  it("a message: each new agent reply, not user messages or history", () => {
    const tr = new ActivityTracker();
    const s = [{ sid: "a", state: "running" }];
    tr.update(s, 0, { now: 1000, events: { a: [msg("e1", 500)] } });
    let a = tr.update(s, 0, { events: { a: [msg("e1", 500), msg("e2", 1500, "message.user")] } });
    expect(a.messages).toBe(0);
    a = tr.update(s, 0, { events: { a: [msg("e1", 500), msg("e2", 1500, "message.user"), msg("e3", 1600)] } });
    expect(a.messages).toBe(1);
    // The same replies again count nothing; a session whose history loads late counts only new replies.
    a = tr.update(s, 0, { events: { a: [msg("e3", 1600)], b: [msg("x1", 200), msg("x2", 1700)] } });
    expect(a.messages).toBe(2);
  });

  it("a reply that lands after a newer live-only event, or out of order, still counts once", () => {
    const tr = new ActivityTracker();
    const s = [{ sid: "a", state: "running" }];
    tr.update(s, 0, { now: 1000, events: { a: [msg("e1", 500)] } });
    let a = tr.update(s, 0, { events: { a: [msg("e1", 500), msg("live1", 1700, "terminal.output", true)] } });
    expect(a.messages).toBe(0);
    a = tr.update(s, 0, {
      events: { a: [msg("e1", 500), msg("e9", 1600), msg("live1", 1700, "terminal.output", true)] },
    });
    expect(a.messages).toBe(1);
    a = tr.update(s, 0, { events: { a: [msg("e0", 1550), msg("e9", 1600)] } });
    expect(a.messages).toBe(2);
    // Gone from the store (a resync) and back: not counted again.
    tr.update(s, 0, { events: { a: [] } });
    expect(tr.update(s, 0, { events: { a: [msg("e0", 1550), msg("e9", 1600)] } }).messages).toBe(2);
  });

  it("an agent alert: each new pending notification, once, even if the list empties and refills", () => {
    const tr = new ActivityTracker();
    tr.update([], 0, { now: 1000, notifications: [{ nid: "old", state: "pending", createdAt: 10 }] });
    let a = tr.update([], 0, {
      notifications: [
        { nid: "old", state: "pending", createdAt: 10 },
        { nid: "n1", state: "pending", createdAt: 2000 },
        { nid: "n2", state: "acked", createdAt: 2000 },
      ],
    });
    expect(a.alerts).toBe(1);
    tr.update([], 0, { notifications: [] });
    a = tr.update([], 0, { notifications: [{ nid: "n1", state: "pending", createdAt: 2000 }] });
    expect(a.alerts).toBe(1);
  });

  it("while the store is still loading it only learns; priming waits for the load", () => {
    const tr = new ActivityTracker();
    tr.update([], 0, { now: 1000, learning: true });
    // Loaded rows look recent (updated_at bumps on every write) but arrive while learning: not news.
    const a = tr.update([{ sid: "a", state: "running", updatedAt: 5000 }], 0, {
      now: 5000,
      learning: true,
      events: { a: [msg("e1", 4900)] },
      notifications: [{ nid: "n1", state: "pending", createdAt: 4900 }],
    });
    expect(a).toMatchObject({ started: 0, messages: 0, alerts: 0, mode: "working" });
    tr.update([{ sid: "a", state: "running", updatedAt: 5000 }], 0, { now: 6000 });
    const b = tr.update([{ sid: "a", state: "completed", updatedAt: 7000 }], 0, {
      events: { a: [msg("e1", 4900), msg("e2", 7000)] },
      notifications: [{ nid: "n2", state: "pending", createdAt: 7000 }],
    });
    expect(b).toMatchObject({ done: 1, messages: 1, alerts: 1 });
  });

  it("a session first seen with no replies still judges its late-loading history by date", () => {
    const tr = new ActivityTracker();
    tr.update([], 0, { now: 1000, events: { a: [msg("t1", 900, "terminal.output", true)] } });
    const a = tr.update([], 0, { events: { a: [msg("old", 500), msg("new", 1500)] } });
    expect(a.messages).toBe(1);
  });

  it("actions come most important first", () => {
    const zero: Activity = { mode: "rest", done: 0, failed: 0, started: 0, messages: 0, alerts: 0 };
    const all: Activity = { mode: "rest", done: 1, failed: 1, started: 1, messages: 1, alerts: 1 };
    expect(activityActions(zero, all)).toEqual(["slump", "hop", "go", "glance", "perk"]);
    expect(activityActions(zero, { ...zero, messages: 2 })).toEqual(["perk"]);
  });
});
