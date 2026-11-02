import type { DeliveryAdapter } from "./types.js";

/** Default for every MCP client: nothing is pushed, team_read returns everything unread. */
export const pull: DeliveryAdapter = { id: "pull", canWake: false, deliver: () => false };
