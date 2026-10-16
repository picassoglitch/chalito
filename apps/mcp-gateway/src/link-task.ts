import { outsideTaskSid } from "@chalito/crypto";
import type { GatewayReader, LinkTaskView } from "./reader.js";

/**
 * Where an outside hand-off task is (ADR 0022 §4, M16 F), from what the gateway may read: the
 * `link_handoff` approval the agent made for it and the session it started. The agent names that
 * session `outsideTaskSid(owner, origin, cid)`, so the gateway finds both.
 *
 * While the owner hasn't answered, the task is `TASK_STATE_AUTH_REQUIRED`, not `INPUT_REQUIRED`:
 * A2A uses INPUT_REQUIRED when the *caller* must send more, and AUTH_REQUIRED when an
 * authorization outside the caller's message is needed. Here nothing the caller sends can move it;
 * only the owner's signed tap can.
 */

export type LinkTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_FAILED";

/** A relayed command lives 5 minutes; past that (plus slack) with no approval, the device never took it. */
export const RELAY_PICKUP_MS = 6 * 60_000;
/** Approved but no session after this: it couldn't start. */
export const START_GRACE_MS = 2 * 60_000;

export const linkTaskState = (
  v: LinkTaskView,
  o: { confirm: boolean; issuedAt: number; now: number },
): { state: LinkTaskState; note: string } => {
  if (v.session) return { state: "TASK_STATE_WORKING", note: "The owner's agent is working on it." };
  const a = v.approval;
  if (a) {
    if (a.status === "denied") return { state: "TASK_STATE_REJECTED", note: "The owner declined the task." };
    if (a.status === "expired" || (a.status === "pending" && a.expiresAt <= o.now))
      return { state: "TASK_STATE_REJECTED", note: "The owner didn't confirm the task in time." };
    if (a.status === "rejected_invalid")
      return { state: "TASK_STATE_REJECTED", note: "The confirmation wasn't valid." };
    if (a.status === "approved")
      return (a.resolvedAt ?? o.now) + START_GRACE_MS <= o.now
        ? { state: "TASK_STATE_FAILED", note: "Confirmed, but the owner's agent couldn't start it." }
        : { state: "TASK_STATE_SUBMITTED", note: "Confirmed; the owner's agent is starting it." };
    return { state: "TASK_STATE_AUTH_REQUIRED", note: "Waiting for the owner to confirm on their phone." };
  }
  if (o.issuedAt + RELAY_PICKUP_MS <= o.now)
    return { state: "TASK_STATE_REJECTED", note: "The owner's computer didn't pick up the task in time." };
  return o.confirm
    ? { state: "TASK_STATE_AUTH_REQUIRED", note: "Waiting for the owner to confirm on their phone." }
    : { state: "TASK_STATE_SUBMITTED", note: "Handed to the owner's agent." };
};

/** `origin` is the task's (`mcp:<provider>`, `a2a:<grant>`): the device names the session from it. */
export const readLinkTask = async (
  reader: GatewayReader,
  owner: string,
  t: { deviceId: string; cid: string; origin: string; confirm: boolean; issuedAt: number },
  now: number,
) =>
  linkTaskState(await reader.linkTask(owner, t.deviceId, await outsideTaskSid(owner, t.origin, t.cid)), { ...t, now });
