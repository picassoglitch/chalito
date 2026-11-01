import { attachApprovalDisplay, type ChalitoClient } from "@chalito/client";
import type { BoardLink } from "./link.js";

type Client = Pick<ChalitoClient, "live" | "actions">;

// Attached on every hello, detached on unplug. The board lights its LED from these frames while an
// approval is pending, with no timed alert: owner, 2026-10-30, "we can't pressure them".
export const attachBoardApprovals = (link: BoardLink, client: Client): (() => void) => {
  let display: { close: () => void } | null = null;
  const sync = () => {
    if (link.ready && !display) {
      const d = attachApprovalDisplay(client.live, client.actions, link.approvalTransport());
      display = d;
      // Unplugged: forget it so the next hello attaches a fresh one.
      const off = link.subscribe(() => {
        if (!link.ready && display === d) {
          off();
          d.close();
          display = null;
        }
      });
    }
  };
  const offLink = link.subscribe(sync);
  sync();

  return () => {
    offLink();
    display?.close();
    display = null;
  };
};
