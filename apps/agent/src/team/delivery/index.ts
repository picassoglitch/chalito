import { appServer } from "./app-server.js";
import { mcpChannel } from "./mcp-channel.js";
import { pull } from "./pull.js";
import type { DeliveryAdapter, DeliveryContext, DeliveryFactory } from "./types.js";

export type { DeliveryAdapter, DeliveryFactory, DeliveryContext, TeamBatch, TeamMessage } from "./types.js";

/**
 * Fallback chain, first match wins, pull always last. Extension points not built yet:
 * - acp: an ACP agent (Agent Client Protocol) gets the batch as `session/prompt` on its session.
 * - a2a: a remote Agent2Agent peer gets it as a `message/send` task; needs remote identity first.
 * The command adapter (configured local CLI per trusted id) slots in before pull.
 */
export const DEFAULT_CHAIN: readonly DeliveryFactory[] = [appServer(), mcpChannel];

export const selectDelivery = (
  ctx: DeliveryContext,
  chain: readonly DeliveryFactory[] = DEFAULT_CHAIN,
): DeliveryAdapter => {
  for (const factory of chain) {
    const adapter = factory.select(ctx);
    if (adapter) return adapter;
  }
  return pull;
};
