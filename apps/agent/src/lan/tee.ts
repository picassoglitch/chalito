import type { AgentEvent } from "@chalito/protocol";
import type { AgentStore } from "../store.js";

/**
 * The store the core writes to, with every event also copied (best effort, live) to the LAN links.
 * The cloud write is unchanged and still awaited: the cloud stays the record for history, and
 * a phone or a late client resyncs from it as before. Every other store method passes through
 * untouched (a Proxy, so methods added to AgentStore later need no change here).
 */
export const lanTee = <S extends AgentStore>(store: S, lan: () => { broadcastEvent(e: AgentEvent): void } | null): S =>
  new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "writeEvent")
        return (e: AgentEvent) => {
          try {
            lan()?.broadcastEvent(e);
          } catch {
            /* the LAN copy never blocks the durable write */
          }
          return target.writeEvent(e);
        };
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
