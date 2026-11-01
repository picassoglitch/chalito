import { describe, expect, it, vi } from "vitest";
import type { ApprovalView, DeviceView, Snapshot } from "../src/live.js";
import { ApprovalConsole, attachApprovalDisplay } from "../src/approval-console.js";

const NOW = 1_790_000_000_000;
const approval = (aid: string, agentDeviceId = "pc-a", extra: Partial<ApprovalView> = {}): ApprovalView => ({
  aid,
  sid: `session-${aid}`,
  agentDeviceId,
  requestId: `request-${aid}`,
  kind: "tool",
  risk: "MED",
  origin: "local",
  stepUpRequired: false,
  verified: true,
  detailsHash: "a".repeat(64),
  status: "pending",
  reason: null,
  createdAt: NOW,
  expiresAt: NOW + 600_000,
  details: { summary: "Bash: npm install" },
  rev: 1,
  ...extra,
});
const setup = (approvals: ApprovalView[] = [approval("a1"), approval("a2", "pc-b")]) => {
  let now = NOW;
  let snapshot: Snapshot = {
    status: "live",
    approvals,
    sessions: approvals.map((a) => ({
      sid: a.sid,
      agentDeviceId: a.agentDeviceId,
      appId: "cursor-cli",
      adapter: "acp",
      updatedAt: NOW,
      card: null,
      coord: null,
      rev: 1,
    })),
    events: {},
    drafts: {},
    notifications: [],
    devModeActive: false,
    devices: ["pc-a", "pc-b"].map(
      (deviceId) =>
        ({
          deviceId,
          role: "agent",
          kind: "desktop",
          platform: "linux",
          lastSeenAt: NOW,
          devMode: { on: false, toggles: [], since: null },
          policyHash: null,
          lastEvent: null,
          rev: 1,
          name: deviceId,
          online: true,
          revoked: false,
          setup: {
            adapters: ["cursor-cli"],
            labels: [],
            workspaces: 0,
            tools: [
              {
                appId: "cursor-cli",
                name: "Cursor CLI",
                state: "connected",
                installed: true,
                signinAllowed: true,
                sessionCapable: true,
                sessionEnabled: true,
              },
            ],
          },
        }) as DeviceView,
    ),
  };
  const listeners = new Set<() => void>();
  const live = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  const decide = vi.fn<(aid: string, allow: boolean) => Promise<void>>().mockResolvedValue(undefined);
  let n = 0;
  const console = new ApprovalConsole(
    live,
    { decide },
    { now: () => now, newTicket: () => `ticket-${String(++n).padStart(16, "0")}` },
  );
  const update = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((fn) => fn());
  };
  const press = (allow: boolean) => {
    const a = console.getSnapshot().approval!;
    return { v: 1, type: "decide", aid: a.aid, ticket: a.ticket, allow };
  };
  return {
    console,
    live,
    decide,
    update,
    press,
    snapshot: () => snapshot,
    clock: (value: number) => {
      now = value;
    },
  };
};

describe("small LCD approval console", () => {
  it("tells the host why the display stopped, and survives a host callback that throws", async () => {
    vi.useFakeTimers({ now: NOW });
    const s = setup();
    let receive!: (command: unknown) => void;
    const onClose = vi.fn();
    const failing = attachApprovalDisplay(
      s.live,
      { decide: s.decide },
      { write: () => Promise.reject(new Error("usb gone")), listen: () => () => undefined },
      { onClose },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("write_failed");
    failing.close();
    expect(onClose).toHaveBeenCalledTimes(1);

    const onClose2 = vi.fn();
    const ok = attachApprovalDisplay(
      s.live,
      { decide: s.decide },
      {
        write: vi.fn().mockResolvedValue(undefined),
        listen: (onCommand) => {
          receive = onCommand;
          return () => undefined;
        },
      },
      {
        onResult: () => {
          throw new Error("host bug");
        },
        onClose: onClose2,
      },
    );
    try {
      receive({ v: 1, type: "next" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onClose2).not.toHaveBeenCalled();
      expect(ok.controller.getSnapshot().state).not.toBe("revoked");
    } finally {
      ok.close();
      expect(onClose2).toHaveBeenCalledExactlyOnceWith("closed");
      s.console.close();
      vi.useRealTimers();
    }
  });

  it("feeds a connected display a heartbeat and stops accepting its buttons after disconnect", async () => {
    vi.useFakeTimers({ now: NOW });
    const s = setup();
    let disconnect!: () => void;
    let receive!: (command: unknown) => void;
    const unlisten = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const bound = attachApprovalDisplay(
      s.live,
      { decide: s.decide },
      {
        write,
        listen: (onCommand, onDisconnect) => {
          receive = onCommand;
          disconnect = onDisconnect;
          return unlisten;
        },
      },
    );
    try {
      expect(write).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(write).toHaveBeenCalledTimes(2);
      const shown = bound.controller.getSnapshot().approval!;
      disconnect();
      expect(unlisten).toHaveBeenCalledTimes(1);
      receive({ v: 1, type: "decide", aid: shown.aid, ticket: shown.ticket, allow: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(write).toHaveBeenCalledTimes(2);
      expect(s.decide).not.toHaveBeenCalled();
      expect(bound.controller.getSnapshot()).toMatchObject({ state: "revoked", approval: null });
    } finally {
      bound.close();
      s.console.close();
      vi.useRealTimers();
    }
  });

  it("shows the actual agent and PC, navigates the shared queue, and decides exactly one request", async () => {
    const s = setup();
    expect(s.console.getSnapshot()).toMatchObject({
      count: 2,
      position: 1,
      state: "pending",
      approval: { computer: "pc-a", agent: "Cursor CLI", canApprove: true },
    });
    await s.console.handle({ v: 1, type: "next" });
    const button = s.press(true);
    expect(s.console.getSnapshot()).toMatchObject({ position: 2, approval: { computer: "pc-b" } });
    expect(await s.console.handle(button)).toEqual({ ok: true });
    expect(s.decide).toHaveBeenCalledExactlyOnceWith("a2", true);
    expect(await s.console.handle(button)).toEqual({ ok: false, reason: "stale" });
    expect(s.console.getSnapshot().approval?.aid).toBe("a1");
    s.console.close();
  });

  it.each([
    { risk: "HIGH" as const },
    { risk: "CRITICAL" as const },
    { stepUpRequired: true },
    { details: { summary: "truncated…", summaryTruncated: true } },
    { details: { summary: "x".repeat(321) } },
    { details: { summary: "hidden\u202ecommand" } },
    { details: null },
    // A Mesa choice is a decision the small screen can't show.
    { mesa: {} as never },
  ])("requires the phone for an action the display cannot approve: %j", async (extra) => {
    const s = setup([approval("a1", "pc-a", extra)]);
    expect(s.console.getSnapshot().state).toBe("phone_required");
    expect(await s.console.handle(s.press(true))).toEqual({ ok: false, reason: "phone_required" });
    expect(s.decide).not.toHaveBeenCalled();
    expect(await s.console.handle(s.press(false))).toEqual({ ok: true });
    expect(s.decide).toHaveBeenCalledExactlyOnceWith("a1", false);
    s.console.close();
  });

  it("can deny an unverified request but cannot approve it", async () => {
    const s = setup([approval("a1", "pc-a", { verified: false, detailsHash: null })]);
    expect(s.console.getSnapshot().state).toBe("unverified");
    expect((await s.console.handle(s.press(true))).ok).toBe(false);
    expect(await s.console.handle(s.press(false))).toEqual({ ok: true });
    expect(s.decide).toHaveBeenCalledExactlyOnceWith("a1", false);
    s.console.close();
  });

  it("invalidates displayed buttons when details change, the phone answers, or a request expires", async () => {
    const s = setup();
    const old = s.press(true);
    s.update({
      approvals: [
        approval("a1", "pc-a", { detailsHash: "b".repeat(64), details: { summary: "Edit: another file" } }),
        approval("a2", "pc-b"),
      ],
    });
    expect(await s.console.handle(old)).toEqual({ ok: false, reason: "stale" });
    const changed = s.press(true);
    s.update({ approvals: [approval("a1", "pc-a", { status: "approved" }), approval("a2", "pc-b")] });
    expect(await s.console.handle(changed)).toEqual({ ok: false, reason: "stale" });
    const last = s.press(true);
    s.clock(NOW + 600_000);
    expect(await s.console.handle(last)).toEqual({ ok: false, reason: "stale" });
    expect(s.console.getSnapshot().state).toBe("empty");
    expect(s.decide).not.toHaveBeenCalled();
    s.console.close();
  });

  it("disables both buttons when the tool PC is offline and invalidates tickets after reconnecting", async () => {
    const s = setup([approval("a1")]);
    const old = s.press(true);
    s.update({ devices: s.snapshot().devices.map((d) => ({ ...d, online: false })) });
    expect(s.console.getSnapshot()).toMatchObject({
      state: "offline",
      approval: { canApprove: false, canDeny: false },
    });
    expect((await s.console.handle(old)).ok).toBe(false);
    s.update({ devices: s.snapshot().devices.map((d) => ({ ...d, online: true })) });
    expect(await s.console.handle(old)).toEqual({ ok: false, reason: "stale" });
    s.console.close();
  });

  it("clears content and rejects decisions after account revocation or disconnect", async () => {
    const s = setup();
    const old = s.press(true);
    s.update({ status: "revoked" });
    expect(s.console.getSnapshot()).toMatchObject({ state: "revoked", approval: null });
    expect((await s.console.handle(old)).ok).toBe(false);
    s.console.close();
    expect(await s.console.handle(old)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("accepts one button press while sending; a failed send needs a new button press", async () => {
    const s = setup();
    let fail!: (reason: Error) => void;
    s.decide.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const button = s.press(true);
    const first = s.console.handle(button);
    expect(s.console.getSnapshot().state).toBe("busy");
    expect((await s.console.handle(button)).ok).toBe(false);
    fail(new Error("offline"));
    expect(await first).toEqual({ ok: false, reason: "send_failed" });
    expect(await s.console.handle(button)).toEqual({ ok: false, reason: "stale" });
    expect(s.decide).toHaveBeenCalledTimes(1);
    s.console.close();
  });

  it("rejects arbitrary commands and never forwards a blanket approval", async () => {
    const s = setup();
    expect(await s.console.handle({ ...s.press(true), all: true })).toEqual({ ok: false, reason: "invalid" });
    expect(await s.console.handle({ v: 1, type: "approve-all" })).toEqual({ ok: false, reason: "invalid" });
    expect(s.decide).not.toHaveBeenCalled();
    s.console.close();
  });
});
