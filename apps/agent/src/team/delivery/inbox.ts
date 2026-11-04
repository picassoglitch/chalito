import type { DeliveryFactory } from "./types.js";

export const INBOX = "inbox";

// A Claude Code session whose Chalito mod is connected: pushed batches become a turn once it is idle. A loaded
// channel wins (it delivers mid-turn); ackOnRead because the mod gives no receipt beyond taking the line.
export const inbox: DeliveryFactory = {
  id: INBOX,
  select: ({ client, link }) =>
    link && client.inbox && !client.channel
      ? {
          id: INBOX,
          canWake: true,
          ackOnRead: true,
          deliver: (batch) => link.push({ teamDelivery: { adapter: INBOX, batch } }),
        }
      : null,
};
