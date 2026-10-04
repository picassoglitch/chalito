import { describe, expect, it } from "vitest";
import { probeLimits, servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { ORCHESTRATOR_ROUTES } from "../src/limits.js";
import { harness } from "./harness.js";

describe("orchestrator route limits (M15)", () => {
  it("every served route has an entry in src/limits.ts, and every entry is a served route", async () => {
    expect(servedRoutes((await harness()).app)).toEqual(tableRoutes(ORCHESTRATOR_ROUTES));
  });

  it("every route is rate-limited at its capacity and refuses bodies over its cap", async () => {
    expect(await probeLimits((await harness()).app, ORCHESTRATOR_ROUTES)).toEqual([]);
  }, 60_000);
});
