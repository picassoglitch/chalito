import type { DeliveryAdapter, DeliveryFactory } from "./types.js";

/**
 * Extension point for apps that run their own local server and accept new turns there (Codex app-server).
 * Chalito ships no implementation; a provider module registers one and the chain picks it for that provider.
 */
export interface AppServerDelivery {
  provider: string;
  adapter(): DeliveryAdapter;
}

export const appServer = (impls: readonly AppServerDelivery[] = []): DeliveryFactory => ({
  id: "app-server",
  select: ({ provider }) => impls.find((i) => i.provider === provider)?.adapter() ?? null,
});
