import { describe, expect, it } from "vitest";
import { probeLimits, servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { NOTIFIER_ROUTES } from "../src/limits.js";
import { setup } from "./harness.js";

describe("notifier route limits (M15)", () => {
  it("every served route has an entry in src/limits.ts, and every entry is a served route", async () => {
    expect(servedRoutes(setup({ billing: true }).app)).toEqual(tableRoutes(NOTIFIER_ROUTES));
  });

  it("every route is rate-limited at its capacity and refuses bodies over its cap", async () => {
    expect(await probeLimits(setup({ billing: true }).app, NOTIFIER_ROUTES)).toEqual([]);
  }, 120_000);
});
