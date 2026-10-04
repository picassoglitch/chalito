import { Hono } from "hono";
import { z } from "zod";
import type { CatalogConfig } from "@chalito/config";
import { HubUnavailable, type HubClient } from "@chalito/billing";
import { CosmeticSlot, type HubUsageEvent } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { StoreRepo } from "./repo.js";

export interface StoreDeps {
  repo: StoreRepo;
  catalog: CatalogConfig;
  hub: Pick<HubClient, "admit" | "settle">;
}

/** A store.purchase is already a price (D-030): the hub bills ceil(cost / 4), so cost = tokens × 4. */
export const MICROS_PER_TOKEN = 4;

/** Own keys only: `__proto__`, `constructor` and friends match the id pattern but aren't items (R-L9). */
const itemOf = (catalog: CatalogConfig, id: string) =>
  Object.hasOwn(catalog.cosmetics, id) ? catalog.cosmetics[id] : undefined;

const PurchaseId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const CosmeticId = z.string().regex(/^[a-z0-9_]{1,64}$/);
const Purchase = z.object({ cosmeticId: CosmeticId, purchaseId: PurchaseId });
const Equip = z.object({
  companionId: z.string().regex(/^chl_[a-z2-7]{26}$/),
  slot: CosmeticSlot,
  cosmeticId: CosmeticId.nullable(),
});

/**
 * The pay-to-dress store (M8). Cosmetics change how a companion looks and nothing else: no route
 * here touches entitlements, model profiles or safety. Paid items are bought from the hub balance:
 * admit (no_tokens → refused), then one transaction writes the purchase, the inventory row and the
 * store.purchase usage event, then the reservation is settled. `purchaseId` makes retries safe.
 */
export const storeRoutes = (deps: Deps, store: StoreDeps) => {
  const app = new Hono<AuthEnv>();
  const auth = requireAuth(deps, ["user", "client"]);
  const limiter = rateLimit({ capacity: 20, refillPerSec: 0.5, now: deps.now });

  app.get("/catalog", auth, async (c) => {
    const owned = await store.repo.owned(principal(c).owner);
    const items = Object.entries(store.catalog.cosmetics).map(([id, x]) => ({
      id,
      name: x.name,
      slot: x.slot,
      free: x.free,
      ...(x.priceTokens !== undefined ? { priceTokens: x.priceTokens } : {}),
      art: x.art,
      card: x.card,
      owned: x.free || owned.has(id),
    }));
    return c.json({ items });
  });

  app.post("/purchase", auth, limiter, async (c) => {
    const p = principal(c);
    const body = Purchase.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { cosmeticId, purchaseId } = body.data;
    const item = itemOf(store.catalog, cosmeticId);
    if (!item) return fail(404, "unknown_cosmetic");

    if (item.free) {
      await store.repo.grantFree(p.owner, cosmeticId);
      return c.json({ status: "owned", cosmeticId, charged: 0 });
    }
    const price = item.priceTokens!;

    // A retry of a purchase that went through: answer it again, never charge again.
    const prior = await store.repo.findPurchase(purchaseId);
    if (prior) {
      if (prior.owner !== p.owner || prior.cosmeticId !== cosmeticId) return fail(409, "purchase_id_conflict");
      return c.json({ status: "owned", cosmeticId, charged: prior.priceTokens, replay: true });
    }
    if ((await store.repo.owned(p.owner)).has(cosmeticId)) return c.json({ status: "owned", cosmeticId, charged: 0 });

    const sourceId = `store:${purchaseId}`;
    let admit;
    try {
      admit = await store.hub.admit({
        external_user_id: p.owner,
        external_job_id: sourceId,
        class: "job",
        operation: "store.purchase",
        est_tokens: price,
        ttl_seconds: 300,
      });
    } catch (err) {
      if (err instanceof HubUnavailable) return fail(503, "hub_unavailable");
      throw err;
    }
    // An admit is not a balance check: a balance short of the price is no_tokens too (R-L9).
    if (admit.allowed && !admit.balance.unlimited && admit.balance.remaining < price) {
      await store.hub.settle({ reservation_id: admit.reservation_id, outcome: "cancelled" });
      return c.json({ error: "no_tokens", chips: [{ label: "¿Por qué?", href: "/creditos" }] }, 402);
    }
    if (!admit.allowed) {
      if (admit.reason === "no_tokens")
        return c.json({ error: "no_tokens", chips: [{ label: "¿Por qué?", href: "/creditos" }] }, 402);
      return fail(402, "not_admitted", admit.reason);
    }

    const event: HubUsageEvent = {
      source_id: sourceId,
      kind: "store.purchase",
      provider: "chalito",
      external_user_id: p.owner,
      amount: 1,
      cost_usd_micros: price * MICROS_PER_TOKEN,
      occurred_at: new Date(deps.now()).toISOString(),
      reservation_id: admit.reservation_id,
      metadata: { cosmetic_id: cosmeticId },
    };
    const result = await store.repo.commitPurchase({
      purchaseId,
      owner: p.owner,
      cosmeticId,
      priceTokens: price,
      reservationId: admit.reservation_id,
      event,
    });
    if (result === "already_owned") {
      await store.hub.settle({ reservation_id: admit.reservation_id, outcome: "cancelled" });
      return c.json({ status: "owned", cosmeticId, charged: 0 });
    }
    // duplicate_purchase: a concurrent retry with the same id committed (same reservation); it settles.
    if (result === "committed") {
      const s = await store.hub.settle({ reservation_id: admit.reservation_id, outcome: "succeeded" });
      // The usage event is already in the outbox; an unsettled reservation just expires on the hub.
      if (!s.ok && !s.closed) console.error("[store] settle failed", s.httpStatus);
      await deps.audit.record({ action: "store.purchase", owner: p.owner, actor: p.uid, target: cosmeticId });
    }
    return c.json({ status: "owned", cosmeticId, charged: price, ...(result === "committed" ? {} : { replay: true }) });
  });

  app.post("/equip", auth, limiter, async (c) => {
    const p = principal(c);
    const body = Equip.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { companionId, slot, cosmeticId } = body.data;
    if (cosmeticId !== null) {
      const item = itemOf(store.catalog, cosmeticId);
      if (!item) return fail(404, "unknown_cosmetic");
      if (item.slot !== slot) return fail(400, "wrong_slot");
      if (item.free) await store.repo.grantFree(p.owner, cosmeticId);
      else if (!(await store.repo.owned(p.owner)).has(cosmeticId)) return fail(403, "not_owned");
    }
    if (!(await store.repo.equip(p.owner, companionId, slot, cosmeticId))) return fail(404, "unknown_companion");
    return c.json({ ok: true, slot, cosmeticId });
  });

  return app;
};
