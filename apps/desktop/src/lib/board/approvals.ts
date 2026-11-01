import { attachApprovalDisplay, type ApprovalConsoleResult, type ChalitoClient } from "@chalito/client";
import type { ApprovalProblem, BoardLink } from "./link.js";

type Client = Pick<ChalitoClient, "live" | "actions">;

/** What the panel says about a result; invalid/stale/unavailable are the screen catching up. */
const problemOf = (r: ApprovalConsoleResult): ApprovalProblem | null =>
  !r.ok && (r.reason === "send_failed" || r.reason === "phone_required") ? r.reason : null;

// Attached on every hello, detached on unplug. The board lights its LED from these frames while an
// approval is pending, with no timed alert: owner, 2026-10-30, "we can't pressure them".
export const attachBoardApprovals = (link: BoardLink, client: Client): (() => void) => {
  let display: { close: () => void; off: () => void } | null = null;
  const drop = (d: typeof display) => {
    if (!d || display !== d) return;
    display = null;
    d.off();
    d.close();
  };
  const sync = () => {
    if (!link.ready || display) return;
    const current = { close: () => undefined, off: () => undefined } as { close: () => void; off: () => void };
    const d = attachApprovalDisplay(client.live, client.actions, link.approvalTransport(), {
      onResult: (r) => {
        if (!r.ok) console.warn(`board: approvals screen: ${r.reason}`);
        if (r.ok || problemOf(r)) link.reportApproval(problemOf(r));
      },
      onClose: (reason) => {
        if (reason !== "write_failed") return;
        console.warn("board: approvals screen stopped: a frame couldn't be written");
        link.reportApproval("write_failed");
        // The next link change (a hello) attaches a fresh one.
        drop(current);
      },
    });
    current.close = d.close;
    // Unplugged: forget it so the next hello attaches a fresh one.
    current.off = link.subscribe(() => {
      if (!link.ready) drop(current);
    });
    display = current;
    if (link.getSnapshot().approvalProblem === "write_failed") link.reportApproval(null);
  };
  const offLink = link.subscribe(sync);
  sync();

  return () => {
    offLink();
    drop(display);
  };
};
