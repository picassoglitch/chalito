// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@chalito/client";
import { attachBoardApprovals } from "../src/lib/board/approvals.js";
import { setup, until } from "./board-helpers.js";

afterEach(() => vi.restoreAllMocks());

const AID = "a1b2c3d4e5f6";
const DEVICE = "pc-b";
const live = (risk: "LOW" | "HIGH") => {
  const snap = {
    status: "live",
    approvals: [
      {
        aid: AID,
        sid: "s1",
        agentDeviceId: DEVICE,
        status: "pending",
        expiresAt: Date.now() + 60_000,
        risk,
        stepUpRequired: false,
        verified: true,
        details: { summary: "npm install left-pad" },
      },
    ],
    devices: [{ deviceId: DEVICE, online: true, name: "Work PC B" }],
    sessions: [],
    notifications: [],
    events: {},
  } as unknown as Snapshot;
  return { subscribe: () => () => undefined, getSnapshot: () => snap };
};

const shownTicket = (sent: Record<string, unknown>[]) => {
  const f = sent.findLast((m) => (m as { approval?: unknown }).approval) as { approval: { ticket: string } };
  return f.approval.ticket;
};

describe("board approvals in the panel", () => {
  it("logs and reports a decision that didn't reach the agent, and clears it on the next success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    let fail = true;
    const decide = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide } } as never);
    board.plug();
    await until(() => board.sent("approval-console").some((f) => f.state === "pending"));
    board.decide(AID, shownTicket(board.sent("approval-console")), true);
    await until(() => link.getSnapshot().approvalProblem !== null);
    expect(link.getSnapshot().approvalProblem).toBe("send_failed");
    expect(warn.mock.calls.some((c) => String(c.join(" ")).includes("send_failed"))).toBe(true);
    fail = false;
    await until(() => board.sent("approval-console").at(-1)?.state === "pending");
    board.decide(AID, shownTicket(board.sent("approval-console")), false);
    await until(() => link.getSnapshot().approvalProblem === null);
    off();
  });

  it("says a risky approval needs the phone when the board tries to approve it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    const off = attachBoardApprovals(link, { live: live("HIGH"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => board.sent("approval-console").some((f) => f.state === "phone_required"));
    board.decide(AID, shownTicket(board.sent("approval-console")), true);
    await until(() => link.getSnapshot().approvalProblem === "phone_required");
    off();
  });

  it("reports a display that stopped on a failed write, and attaches a fresh one when it can", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    const real = link.approvalTransport.bind(link);
    let broken = true;
    link.approvalTransport = (onWritten) => {
      const t = real(onWritten);
      return { ...t, write: (f) => (broken ? Promise.reject(new Error("usb")) : t.write(f)) };
    };
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => link.getSnapshot().approvalProblem === "write_failed");
    broken = false;
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: board.keyId });
    await until(() => board.sent("approval-console").length > 0);
    // The fresh screen works again: the panel stops saying it doesn't.
    await until(() => link.getSnapshot().approvalProblem === null);
    off();
  });

  it("leaves no subscriptions on the link after its cleanup", async () => {
    const { board, link } = await setup();
    let active = 0;
    const subscribe = link.subscribe;
    link.subscribe = (fn) => {
      active++;
      const unsub = subscribe(fn);
      return () => {
        active--;
        unsub();
      };
    };
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => board.sent("approval-console").length > 0);
    off();
    expect(active).toBe(0);
  });
});

describe("approvals-screen problems go away", () => {
  it("the real transport stops the screen after frames keep failing while connected, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup({ frameFailures: 2 });
    board.failNext.set("approval-console", 2);
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => link.getSnapshot().approvalProblem === "write_failed");
    expect(warn.mock.calls.some((c) => String(c.join(" ")).includes("approval-console"))).toBe(true);
    off();
  });

  it("phone_required clears once that approval leaves the list (answered on the phone)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    const feed = live("HIGH");
    let snap = feed.getSnapshot();
    const subs = new Set<() => void>();
    const changing = {
      subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
      getSnapshot: () => snap,
    };
    const off = attachBoardApprovals(link, { live: changing, actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => board.sent("approval-console").some((f) => f.state === "phone_required"));
    board.decide(AID, shownTicket(board.sent("approval-console")), true);
    await until(() => link.getSnapshot().approvalProblem === "phone_required");
    snap = { ...snap, approvals: [] };
    for (const f of [...subs]) f();
    await until(() => link.getSnapshot().approvalProblem === null);
    off();
  });

  it("a re-attached screen starts with no old problem", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    const off = attachBoardApprovals(link, { live: live("HIGH"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => board.sent("approval-console").some((f) => f.state === "phone_required"));
    board.decide(AID, shownTicket(board.sent("approval-console")), true);
    await until(() => link.getSnapshot().approvalProblem === "phone_required");
    board.unplug();
    board.plug();
    await until(() => link.ready && link.getSnapshot().approvalProblem === null);
    off();
  });
});

describe("approvals-screen problems, precisely", () => {
  it("a send_failed for an approval that left the feed during the decide still clears", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup();
    const feed = live("LOW");
    let snap = feed.getSnapshot();
    const subs = new Set<() => void>();
    const changing = {
      subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
      getSnapshot: () => snap,
    };
    const decide = async () => {
      // Answered on the phone while the board's decide was in flight.
      snap = { ...snap, approvals: [] };
      for (const f of [...subs]) f();
      throw new Error("offline");
    };
    const off = attachBoardApprovals(link, { live: changing, actions: { decide } } as never);
    const reported: unknown[] = [];
    link.subscribe(() => reported.push(link.getSnapshot().approvalProblem));
    board.plug();
    await until(() => board.sent("approval-console").some((f) => f.state === "pending"));
    board.decide(AID, shownTicket(board.sent("approval-console")), true);
    await until(() => reported.includes("send_failed"));
    await until(() => link.getSnapshot().approvalProblem === null);
    off();
  });

  it("pressing Next on a re-attached screen whose frames still fail doesn't clear write_failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup({ frameFailures: 3 });
    board.failNext.set("approval-console", 1000);
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => link.getSnapshot().approvalProblem === "write_failed");
    // A fresh screen attaches (another hello); its first failures are still under the limit.
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: board.keyId });
    await new Promise((r) => setTimeout(r, 30));
    board.emit({ v: 1, type: "next" });
    await new Promise((r) => setTimeout(r, 50));
    expect(link.getSnapshot().approvalProblem).toBe("write_failed");
    off();
  });

  it("write_failed stays while frames still fail, even as the screen re-attaches on other changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { board, link } = await setup({ frameFailures: 1 });
    board.failNext.set("approval-console", 1000);
    const off = attachBoardApprovals(link, { live: live("LOW"), actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => link.getSnapshot().approvalProblem === "write_failed");
    const seen: unknown[] = [];
    link.subscribe(() => seen.push(link.getSnapshot().approvalProblem));
    // An unrelated change: the same paired board says hello again.
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: board.keyId });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(null);
    // Frames go out again: the first one that does clears it.
    board.failNext.set("approval-console", 0);
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: board.keyId });
    await until(() => link.getSnapshot().approvalProblem === null);
    off();
  });
});
