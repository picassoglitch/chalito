import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fromB64url, verifyDetached } from "@chalito/crypto";
import { SignedRecipeCatalog } from "@chalito/protocol";
import type { Deps } from "../src/deps.js";
import { recipesRoutes } from "../src/routes/recipes.js";

/** The dev-signed catalog (recipes/test-fixtures): what a local api serves. */
const FIXTURE = new URL("../../../recipes/test-fixtures/", import.meta.url);
const signed = JSON.parse(readFileSync(new URL("catalog.dev.signed.json", FIXTURE), "utf8")) as unknown;
const devKey = JSON.parse(readFileSync(new URL("dev-catalog-key.json", FIXTURE), "utf8")) as { publicKey: string };

const app = (recipeCatalog?: Deps["recipeCatalog"]) =>
  new Hono().route(
    "/v1/recipes",
    recipesRoutes({ now: Date.now, ...(recipeCatalog ? { recipeCatalog } : {}) } as Deps),
  );

describe("GET /v1/recipes/catalog", () => {
  it("serves the signed catalog as is, publicly cacheable, and it still verifies on the other side", async () => {
    const res = await app(async () => signed).request("/v1/recipes/catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = SignedRecipeCatalog.parse(await res.json());
    expect(
      await verifyDetached("chalito.recipe-catalog.v1", body.body, body.sig, await fromB64url(devKey.publicKey)),
    ).toBe(true);
  });

  it("404 without a configured catalog; 503 (never relayed) when the file isn't a signed catalog", async () => {
    expect((await app().request("/v1/recipes/catalog")).status).toBe(404);
    expect((await app(async () => null).request("/v1/recipes/catalog")).status).toBe(404);
    expect((await app(async () => Promise.reject(new Error("ENOENT"))).request("/v1/recipes/catalog")).status).toBe(
      404,
    );
    const unsigned = { ...(signed as Record<string, unknown>) };
    delete unsigned.sig;
    const res = await app(async () => unsigned).request("/v1/recipes/catalog");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "catalog_unavailable" });
  });
});
