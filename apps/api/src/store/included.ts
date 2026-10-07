import type { CatalogConfig, CosmeticItem } from "@chalito/config";
import type { StoreRepo } from "./repo.js";

// Type-only imports: the SSO route (and the web's contract test of it) loads this without the
// store's billing client.

/** True when the owner's hub tier wears this item at no cost (catalog `includedIn`). */
export const includedFor = (item: CosmeticItem, tier: string | null) =>
  !!tier && item.slot === "skin" && (item.includedIn as readonly string[] | undefined)?.includes(tier) === true;

/**
 * Plan-included skins the owner's tier no longer covers (a VIP who downgraded) come off their
 * companions, unless they bought the skin. Run where the tier is written (SSO) and when the store
 * is read, so the equipped map never keeps a perk the plan stopped paying for.
 */
export const dropLapsedSkins = async (
  store: { repo: Pick<StoreRepo, "dropUnownedSkins">; catalog: CatalogConfig },
  owner: string,
  tier: string | null,
) => {
  const lapsed = Object.entries(store.catalog.cosmetics)
    .filter(([, x]) => x.slot === "skin" && (x.includedIn?.length ?? 0) > 0 && !includedFor(x, tier))
    .map(([id]) => id);
  return lapsed.length ? store.repo.dropUnownedSkins(owner, lapsed) : 0;
};
