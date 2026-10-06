import { Hono } from "hono";
import { SignedRecipeCatalog } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";

/**
 * GET /v1/recipes/catalog (engine contract v2 §1): the curated recipe catalog, signed with
 * Chalito's catalog key. Public and signed out (it's no secret): the agents verify it against a
 * key compiled into them, so this route only relays the signed file and adds no trust of its own.
 * It refuses to serve anything that isn't a well-formed signed catalog. Without a configured file
 * (dev, tests, or before the owner creates the production key) it answers 404.
 */
export const recipesRoutes = (deps: Deps) => {
  const app = new Hono();
  app.get("/catalog", async (c) => {
    const raw = deps.recipeCatalog ? await deps.recipeCatalog().catch(() => null) : null;
    if (raw === null) return fail(404, "no_catalog");
    const parsed = SignedRecipeCatalog.safeParse(raw);
    if (!parsed.success) {
      console.error("[api] recipes: the configured catalog isn't a signed catalog");
      return fail(503, "catalog_unavailable");
    }
    c.header("Cache-Control", "public, max-age=300");
    // As read, not the parse: the signature covers JCS(body), so nothing here may reshape it.
    return c.json(raw as Record<string, unknown>);
  });
  return app;
};
