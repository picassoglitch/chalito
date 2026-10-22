import { describe, expect, it } from "vitest";
import { servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { loadProviders } from "@chalito/config";
import { createGateway } from "../src/app.js";
import { gatewayRoutes } from "../src/limits.js";

describe("ai-gateway route limits (M15)", () => {
  it("every served route has an entry in src/limits.ts, and every entry is a served route", () => {
    const app = createGateway({
      store: {} as never,
      meter: {} as never,
      providers: loadProviders(),
      upstreams: { openai: null, xai: null, google: null },
      enabled: () => false,
      now: Date.now,
    });
    expect(servedRoutes(app)).toEqual(tableRoutes(gatewayRoutes()));
  });
});
