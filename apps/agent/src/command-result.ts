import { CommandRejectReason } from "@chalito/protocol";

const DIRECT = new Set<string>(CommandRejectReason.options);

/**
 * The closed reason a client sees in `command.rejected`, from the core's internal one. Anything
 * unexpected is "internal", so no free text or path can reach the event.
 */
export const publicReason = (raw: string | undefined): CommandRejectReason => {
  if (raw && DIRECT.has(raw)) return raw as CommandRejectReason;
  switch (raw) {
    case "invalid_signature":
    case "wrong_context":
      return "bad_signature";
    case "would_loosen":
      return "policy_would_loosen";
    case "invalid_patch":
      return "policy_invalid";
  }
  if (raw?.startsWith("step_up_")) return "step_up_failed";
  return "internal";
};
