import { describe, expect, it } from "vitest";
import { probeLimits, servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { gatewayRoutes } from "../src/limits.js";
import { RESOURCE } from "../../api/test/oauth-harness.js";
import { gatewayHarness } from "./harness.js";

describe("mcp-gateway route limits (M15)", () => {
  it("every served route has an entry in src/limits.ts, and every entry is a served route", async () => {
    expect(servedRoutes((await gatewayHarness()).gw)).toEqual(tableRoutes(gatewayRoutes(RESOURCE)));
  });

  it("every route is rate-limited at its capacity and refuses bodies over its cap", async () => {
    expect(await probeLimits((await gatewayHarness()).gw, gatewayRoutes(RESOURCE))).toEqual([]);
  }, 60_000);
});
