import type { ApprovalView } from "@chalito/client";
import { needsStepUp } from "./stepup.js";

/** The line a pending approval is shown by. */
export const approvalSummary = (a: Pick<ApprovalView, "details" | "origin">): string =>
  typeof a.details?.summary === "string"
    ? a.details.summary
    : typeof a.details?.tool === "string"
      ? a.details.tool
      : a.origin;

/** Why an approve can't go out from this device right now; one ladder for the Inbox row and the voice card. */
export type ApproveBlock = "nothing" | "unverified" | "phoneOnly" | "openFull";

export const approveBlock = (a: ApprovalView | undefined, canStepUp: boolean): ApproveBlock | null =>
  !a
    ? "nothing"
    : !a.verified
      ? "unverified"
      : needsStepUp(a) && !canStepUp
        ? "phoneOnly"
        : a.details?.summaryTruncated === true
          ? "openFull"
          : null;
