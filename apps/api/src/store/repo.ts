import type { Sql } from "postgres";
import { enqueueUsage } from "@chalito/billing";
import type { CosmeticSlot, HubUsageEvent } from "@chalito/protocol";

export interface PurchaseRecord {
  purchaseId: string;
  owner: string;
  cosmeticId: string;
  priceTokens: number;
}

export type CommitResult = "committed" | "duplicate_purchase" | "already_owned";

/**
 * Inventory, purchases and equipped cosmetics. Every write is server-only (RLS: clients can
 * read their inventory and purchases, never write them, and `companions.equipped` has no
 * client column grant).
 */
export interface StoreRepo {
  owned(owner: string): Promise<Set<string>>;
  /** The owner's hub tier (chalito.users.tier, from the last SSO launch), lowercase; null if unknown. */
  tier(owner: string): Promise<string | null>;
  findPurchase(purchaseId: string): Promise<PurchaseRecord | null>;
  /**
   * One transaction: the purchase row, the inventory row and the store.purchase usage event in
   * the outbox. Nothing is written when the purchase id exists or the item is already owned.
   */
  commitPurchase(p: PurchaseRecord & { reservationId: string; event: HubUsageEvent }): Promise<CommitResult>;
  grantFree(owner: string, cosmeticId: string): Promise<void>;
  /** false when the companion doesn't exist. `cosmeticId: null` takes the slot off. */
  equip(owner: string, companionId: string, slot: CosmeticSlot, cosmeticId: string | null): Promise<boolean>;
}

export class PostgresStoreRepo implements StoreRepo {
  constructor(private readonly sql: Sql) {}

  async owned(owner: string) {
    const rows = await this.sql<{ cosmetic_id: string }[]>`
      select cosmetic_id from chalito.inventory where owner = ${owner}`;
    return new Set(rows.map((r) => r.cosmetic_id));
  }

  async tier(owner: string) {
    const [r] = await this.sql<{ tier: string | null }[]>`select tier from chalito.users where id = ${owner}`;
    return r?.tier ? r.tier.toLowerCase() : null;
  }

  async findPurchase(purchaseId: string) {
    const [r] = await this.sql<{ owner: string; cosmetic_id: string; price_tokens: number }[]>`
      select owner, cosmetic_id, price_tokens from chalito.purchases where purchase_id = ${purchaseId}`;
    return r ? { purchaseId, owner: r.owner, cosmeticId: r.cosmetic_id, priceTokens: r.price_tokens } : null;
  }

  async commitPurchase(p: PurchaseRecord & { reservationId: string; event: HubUsageEvent }) {
    const owned = new Error("already owned");
    try {
      return await this.#commit(p, owned);
    } catch (err) {
      if (err === owned) return "already_owned";
      throw err;
    }
  }

  async #commit(p: PurchaseRecord & { reservationId: string; event: HubUsageEvent }, owned: Error) {
    return (await this.sql.begin(async (tx) => {
      const [bought] = await tx`
        insert into chalito.purchases (purchase_id, owner, cosmetic_id, price_tokens, reservation_id, source_id)
        values (${p.purchaseId}, ${p.owner}, ${p.cosmeticId}, ${p.priceTokens}, ${p.reservationId}, ${p.event.source_id})
        on conflict do nothing
        returning purchase_id`;
      if (!bought) return "duplicate_purchase";
      const [got] = await tx`
        insert into chalito.inventory (owner, cosmetic_id, via, purchase_id)
        values (${p.owner}, ${p.cosmeticId}, 'purchase', ${p.purchaseId})
        on conflict do nothing
        returning cosmetic_id`;
      // Bought concurrently under another purchase id: roll this one back, charge nothing.
      if (!got) throw owned;
      await enqueueUsage(tx, p.owner, [p.event]);
      return "committed";
    })) as CommitResult;
  }

  async grantFree(owner: string, cosmeticId: string) {
    await this.sql`
      insert into chalito.inventory (owner, cosmetic_id, via) values (${owner}, ${cosmeticId}, 'free')
      on conflict do nothing`;
  }

  async equip(owner: string, companionId: string, slot: CosmeticSlot, cosmeticId: string | null) {
    const rows =
      cosmeticId === null
        ? await this.sql`
            update chalito.companions set equipped = equipped - ${slot}
            where owner = ${owner} and companion_id = ${companionId} returning companion_id`
        : await this.sql`
            update chalito.companions set equipped = equipped || jsonb_build_object(${slot}::text, ${cosmeticId}::text)
            where owner = ${owner} and companion_id = ${companionId} returning companion_id`;
    return rows.length > 0;
  }
}

export class MemoryStoreRepo implements StoreRepo {
  readonly inventory = new Map<string, Set<string>>();
  readonly purchases = new Map<string, PurchaseRecord & { reservationId: string }>();
  readonly outbox: HubUsageEvent[] = [];
  readonly companions = new Map<string, Partial<Record<CosmeticSlot, string>>>();
  readonly tiers = new Map<string, string>();

  async owned(owner: string) {
    return new Set(this.inventory.get(owner) ?? []);
  }
  async tier(owner: string) {
    return this.tiers.get(owner) ?? null;
  }
  async findPurchase(purchaseId: string) {
    const p = this.purchases.get(purchaseId);
    return p ? { purchaseId, owner: p.owner, cosmeticId: p.cosmeticId, priceTokens: p.priceTokens } : null;
  }
  async commitPurchase(p: PurchaseRecord & { reservationId: string; event: HubUsageEvent }) {
    if (this.purchases.has(p.purchaseId)) return "duplicate_purchase" as const;
    const inv = this.inventory.get(p.owner) ?? new Set<string>();
    if (inv.has(p.cosmeticId)) return "already_owned" as const;
    this.purchases.set(p.purchaseId, { ...p });
    inv.add(p.cosmeticId);
    this.inventory.set(p.owner, inv);
    if (!this.outbox.some((e) => e.source_id === p.event.source_id)) this.outbox.push(p.event);
    return "committed" as const;
  }
  async grantFree(owner: string, cosmeticId: string) {
    const inv = this.inventory.get(owner) ?? new Set<string>();
    inv.add(cosmeticId);
    this.inventory.set(owner, inv);
  }
  async equip(owner: string, companionId: string, slot: CosmeticSlot, cosmeticId: string | null) {
    const key = `${owner}/${companionId}`;
    const eq = this.companions.get(key);
    if (!eq) return false;
    if (cosmeticId === null) delete eq[slot];
    else eq[slot] = cosmeticId;
    return true;
  }
}
