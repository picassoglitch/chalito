import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeLimits, servedRoutes, tableRoutes } from "@chalito/guard/testing";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/deps.js";
import { API_ROUTES } from "../src/limits.js";

/** Every optional router mounted; the dependencies are inert (only the guard is under test). */
const OPTIONAL = { phone: true, voice: true, store: true, releases: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an inert stand-in for every dependency
const inert: any = new Proxy(() => inert, { get: (_t, p) => (p === "then" ? undefined : inert), apply: () => inert });
const app = () =>
  createApp({
    repo: inert,
    identity: { verify: async () => Promise.reject(new Error("no")) },
    audit: { record: async () => {} },
    mcp: inert,
    rooms: inert,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => 1_790_000_000_000,
    phone: inert,
    voice: { ttlSec: 60 } as never,
    store: { catalog: { schemaVersion: 1, cosmetics: {}, drops: {} } } as never,
    releases: inert,
  } as unknown as Deps);

describe("api route limits (M15)", () => {
  it("the test mounts every optional router createApp has (`if (deps.x)`)", () => {
    const optional = [
      ...readFileSync(new URL("../src/app.ts", import.meta.url), "utf8").matchAll(/if \(deps\.(\w+)\)/g),
    ]
      .map((m) => m[1]!)
      .sort();
    expect(optional).toEqual(Object.keys(OPTIONAL).sort());
  });

  it("every served route has an entry in src/limits.ts, and every entry is a served route", () => {
    expect(servedRoutes(app())).toEqual(tableRoutes(API_ROUTES));
  });

  it("every route is rate-limited at its capacity and refuses bodies over its cap", async () => {
    expect(await probeLimits(app(), API_ROUTES)).toEqual([]);
  }, 60_000);

  it("guessable and costly routes use the shared (Postgres) buckets", () => {
    for (const r of [
      "POST /v1/pairing/resolve",
      "POST /v1/pairing/claim",
      "POST /v1/endorse/resolve",
      "POST /v1/recovery/start",
      "POST /v1/phone/start",
      "POST /oauth/register",
      "POST /sso/exchange",
      "POST /v1/rooms/join",
    ])
      expect(API_ROUTES[r]?.shared, r).toBe(true);
  });
});
