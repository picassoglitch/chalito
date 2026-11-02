import type { DeliveryAdapter, DeliveryFactory } from "./types.js";

/** Extension point for apps that take new turns on their own local server (Codex app-server); none built yet. */
export interface AppServerDelivery {
  provider: string;
  adapter(): DeliveryAdapter;
}

export const appServer = (impls: readonly AppServerDelivery[] = []): DeliveryFactory => ({
  id: "app-server",
  select: ({ provider }) => impls.find((i) => i.provider === provider)?.adapter() ?? null,
});
