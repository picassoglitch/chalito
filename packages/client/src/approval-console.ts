import { ApprovalConsoleCommand, ApprovalConsoleFrame } from "@chalito/protocol";
import type { ClientActions } from "./actions.js";
import type { ApprovalView, Snapshot } from "./live.js";

type Feed = { subscribe(fn: () => void): () => void; getSnapshot(): Snapshot };
export type ApprovalConsoleResult =
  { ok: true } | { ok: false; reason: "invalid" | "stale" | "phone_required" | "unavailable" | "send_failed" };
const identity = (a: ApprovalView) =>
  JSON.stringify([
    a.aid,
    a.sid,
    a.agentDeviceId,
    a.requestId,
    a.detailsHash,
    a.expiresAt,
    a.risk,
    a.stepUpRequired,
    a.verified,
    a.details,
    a.mesa,
  ]);
const cleanLabel = (text: string, max: number) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max);

/**
 * Shared small-screen approval controller. A paired host renders frames to its local display
 * transport and submits decisions with its existing ClientActions. The accessory never gets
 * the account credentials or a blanket approve capability. Physical transport pairing is the
 * host's responsibility; never expose handle() on an unauthenticated network listener.
 */
export class ApprovalConsole {
  #frame: ApprovalConsoleFrame = {
    v: 1,
    type: "approval-console",
    state: "empty",
    count: 0,
    position: 0,
    approval: null,
  };
  #listeners = new Set<() => void>();
  #selected: string | null = null;
  #identity: string | null = null;
  #ticket = "";
  #sent = new Set<string>();
  #busy = false;
  #closed = false;
  #unsubscribe: () => void;
  readonly #now: () => number;
  readonly #newTicket: () => string;

  constructor(
    private readonly live: Feed,
    private readonly actions: Pick<ClientActions, "decide">,
    opts: { now?: () => number; newTicket?: () => string } = {},
  ) {
    this.#now = opts.now ?? Date.now;
    this.#newTicket = opts.newTicket ?? (() => crypto.randomUUID());
    this.#unsubscribe = live.subscribe(() => this.refresh());
    this.refresh();
  }

  getSnapshot = (): ApprovalConsoleFrame => this.#frame;
  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  };

  #queue(snapshot: Snapshot) {
    return snapshot.approvals.filter(
      (a) =>
        a.status === "pending" &&
        a.expiresAt > this.#now() &&
        !snapshot.devices.find((d) => d.deviceId === a.agentDeviceId)?.revoked &&
        !this.#sent.has(identity(a)),
    );
  }

  /** Also call on the host's clock tick, so expiry invalidates buttons without a network event. */
  refresh = (): void => {
    const snapshot = this.live.getSnapshot();
    const pending = new Set(snapshot.approvals.filter((a) => a.status === "pending").map(identity));
    this.#sent = new Set([...this.#sent].filter((key) => pending.has(key)));
    const queue = this.#queue(snapshot);
    const online = !this.#closed && snapshot.status === "live";
    const selected = queue.find((a) => a.aid === this.#selected) ?? queue[0];
    const key = selected ? identity(selected) : null;
    // Connectivity, changed details, and expiry all invalidate previously displayed buttons.
    const device = selected ? snapshot.devices.find((d) => d.deviceId === selected.agentDeviceId) : null;
    const fingerprint = JSON.stringify([key, online, device?.online, this.#busy]);
    if (fingerprint !== this.#identity) {
      this.#identity = fingerprint;
      this.#ticket = this.#newTicket();
    }
    this.#selected = selected?.aid ?? null;
    let frame: ApprovalConsoleFrame = {
      v: 1,
      type: "approval-console",
      state: this.#closed || snapshot.status === "revoked" ? "revoked" : !online ? "offline" : "empty",
      count: online ? queue.length : 0,
      position: 0,
      approval: null,
    };
    if (online && selected) {
      const raw = typeof selected.details?.summary === "string" ? selected.details.summary : "";
      const needsPhone =
        selected.stepUpRequired ||
        selected.risk === "HIGH" ||
        selected.risk === "CRITICAL" ||
        selected.details?.summaryTruncated === true ||
        !raw ||
        raw.length > 320 ||
        /[\p{Cc}\p{Cf}]/u.test(raw) ||
        !!selected.mesa;
      const reachable = device?.online === true;
      const state = this.#busy
        ? "busy"
        : !reachable
          ? "offline"
          : !selected.verified
            ? "unverified"
            : needsPhone
              ? "phone_required"
              : "pending";
      const session = snapshot.sessions.find((s) => s.sid === selected.sid);
      const appId = session?.appId ?? session?.adapter ?? "";
      frame = {
        ...frame,
        state,
        position: queue.indexOf(selected) + 1,
        approval: {
          aid: selected.aid,
          sid: selected.sid,
          computer: cleanLabel(device?.name ?? selected.agentDeviceId, 120),
          agent: cleanLabel(device?.setup?.tools?.find((tool) => tool.appId === appId)?.name ?? appId, 80),
          summary: cleanLabel(raw, 320),
          risk: selected.risk,
          expiresAt: selected.expiresAt,
          ticket: this.#ticket,
          canApprove: state === "pending",
          canDeny: reachable && !this.#busy,
        },
      };
    }
    // A frame that doesn't fit the screen's schema shows as offline instead of breaking every listener.
    const parsed = ApprovalConsoleFrame.safeParse(frame);
    const checked: ApprovalConsoleFrame = parsed.success
      ? parsed.data
      : { v: 1, type: "approval-console", state: "offline", count: 0, position: 0, approval: null };
    if (JSON.stringify(checked) === JSON.stringify(this.#frame)) return;
    this.#frame = checked;
    for (const listener of this.#listeners) listener();
  };

  async handle(input: unknown): Promise<ApprovalConsoleResult> {
    if (this.#closed) return { ok: false, reason: "unavailable" };
    const command = ApprovalConsoleCommand.safeParse(input);
    if (!command.success) return { ok: false, reason: "invalid" };
    this.refresh();
    const c = command.data;
    if (c.type !== "decide") {
      if (this.#busy) return { ok: false, reason: "unavailable" };
      const queue = this.#queue(this.live.getSnapshot());
      if (!queue.length) return { ok: true };
      const index = queue.findIndex((a) => a.aid === this.#selected);
      this.#selected = queue[(index + (c.type === "next" ? 1 : queue.length - 1)) % queue.length]!.aid;
      this.refresh();
      return { ok: true };
    }
    const displayed = this.#frame.approval;
    if (!displayed || displayed.aid !== c.aid || displayed.ticket !== c.ticket) return { ok: false, reason: "stale" };
    if (c.allow && !displayed.canApprove)
      return { ok: false, reason: this.#frame.state === "phone_required" ? "phone_required" : "unavailable" };
    if (!c.allow && !displayed.canDeny) return { ok: false, reason: "unavailable" };
    const a = this.live.getSnapshot().approvals.find((approval) => approval.aid === c.aid)!;
    const key = identity(a);
    this.#busy = true;
    this.refresh();
    try {
      // ClientActions rechecks expiry and signatures and signs for this request's exact PC.
      await this.actions.decide(c.aid, c.allow);
      this.#sent.add(key);
      return { ok: true };
    } catch {
      return { ok: false, reason: "send_failed" };
    } finally {
      this.#busy = false;
      this.#identity = null;
      this.refresh();
    }
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.refresh();
    this.#listeners.clear();
  }
}

/** Supplied by the host after explicitly connecting its local USB/serial accessory. */
export interface ApprovalDisplayTransport {
  write(frame: ApprovalConsoleFrame): Promise<void> | void;
  listen(onCommand: (command: unknown) => void, onDisconnect: () => void): () => void;
}

/**
 * Wires a connected display to the existing approval client. Frames double as a heartbeat;
 * firmware must blank its buttons after losing the heartbeat. Slow writes retain only the
 * newest frame, so a stalled accessory cannot grow an unbounded queue of old approvals.
 */
export const attachApprovalDisplay = (
  live: Feed,
  actions: Pick<ClientActions, "decide">,
  transport: ApprovalDisplayTransport,
  opts: {
    onResult?: (result: ApprovalConsoleResult) => void;
    /** Tells the host the display binding stopped, so it doesn't keep showing "connected". */
    onClose?: (reason: "closed" | "disconnected" | "write_failed") => void;
  } = {},
): { controller: ApprovalConsole; close: () => void } => {
  const controller = new ApprovalConsole(live, actions);
  let closed = false;
  let writing = false;
  let latest: ApprovalConsoleFrame | null = null;
  let removeInput: () => void = () => undefined;
  let removeOutput: () => void = () => undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (reason: "closed" | "disconnected" | "write_failed") => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    removeInput();
    removeOutput();
    controller.close();
    latest = null;
    opts.onClose?.(reason);
  };
  const close = () => stop("closed");
  const flush = async () => {
    if (writing || closed) return;
    writing = true;
    try {
      while (latest && !closed) {
        const frame = latest;
        latest = null;
        await transport.write(frame);
      }
    } catch {
      stop("write_failed");
    } finally {
      writing = false;
    }
  };
  const send = () => {
    latest = controller.getSnapshot();
    void flush();
  };
  removeOutput = controller.subscribe(send);
  removeInput = transport.listen(
    (command) => {
      if (closed) return;
      void controller.handle(command).then((result) => {
        // A host callback that throws is the host's bug, not a reason to drop the display.
        try {
          opts.onResult?.(result);
        } catch {
          /* ignored on purpose */
        }
      });
    },
    () => stop("disconnected"),
  );
  if (!closed) {
    timer = setInterval(() => {
      controller.refresh();
      send();
    }, 1000);
    send();
  } else {
    removeInput();
  }
  return { controller, close };
};
