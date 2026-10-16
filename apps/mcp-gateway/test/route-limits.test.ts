import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeLimits, servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { gatewayRoutes } from "../src/limits.js";
import { A2A_RESOURCE, RESOURCE } from "../../api/test/oauth-harness.js";
import { gatewayHarness } from "./harness.js";

describe("mcp-gateway route limits (M15)", () => {
  // The gateway's clock is Date.now (via the harness): freeze it so no bucket refills mid-probe,
  // however slow the machine (CI under turbo's parallel load).
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("every served route has an entry in src/limits.ts, and every entry is a served route", async () => {
    expect(servedRoutes((await gatewayHarness()).gw)).toEqual(tableRoutes(gatewayRoutes(RESOURCE)));
  });

  it("every route is rate-limited at its capacity and refuses bodies over its cap", async () => {
    expect(await probeLimits((await gatewayHarness()).gw, gatewayRoutes(RESOURCE))).toEqual([]);
  }, 60_000);

  it("with the A2A server on, its routes are in the table and limited too", async () => {
    const gw = (await gatewayHarness({ a2a: true })).gw;
    expect(servedRoutes(gw)).toEqual(tableRoutes(gatewayRoutes(RESOURCE, A2A_RESOURCE)));
    expect(await probeLimits(gw, gatewayRoutes(RESOURCE, A2A_RESOURCE))).toEqual([]);
  }, 60_000);
});
