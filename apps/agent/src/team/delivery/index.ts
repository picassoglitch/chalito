import { appServer } from "./app-server.js";
import { codexQueue } from "./codex-queue.js";
import { mcpChannel } from "./mcp-channel.js";
import { pull } from "./pull.js";
import type { DeliveryAdapter, DeliveryContext, DeliveryFactory } from "./types.js";

export type { DeliveryAdapter, DeliveryFactory, DeliveryContext, TeamBatch, TeamMessage } from "./types.js";

// First match wins, pull last. command, acp and a2a slot in here later (docs/AI_TEAM.md).
export const DEFAULT_CHAIN: readonly DeliveryFactory[] = [appServer(), codexQueue, mcpChannel];

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
