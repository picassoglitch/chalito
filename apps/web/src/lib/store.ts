import type { CardPlacement } from "@chalito/roster";

/**
 * The store (M8, docs/integrations/STORE.md): cosmetics change how a companion looks, never what
 * it can do. Prices are hub tokens, never money. Routes take the person's or this device's bearer.
 */
export type Slot = "head" | "face" | "neck" | "body" | "back" | "aura" | "portal_fx" | "skin";
export type AccessorySlot = Exclude<Slot, "skin">;
/** The card renderer's material effects (@chalito/avatar-three SKIN_IDS). */
export type SkinEffect = "gold" | "galaxy" | "neon" | "crystal" | "holo" | "shadow" | "pixel";
export const SKIN_EFFECTS: readonly SkinEffect[] = ["gold", "galaxy", "neon", "crystal", "holo", "shadow", "pixel"];

interface ItemBase {
  id: string;
  name: { es: string; en: string };
  free: boolean;
  priceTokens?: number;
  owned: boolean;
}

/** A drawn item placed on the card. */
export interface AccessoryItem extends ItemBase {
  slot: AccessorySlot;
  /** A path inside @chalito/roster (cosmetics/<id>.webp). */
  art: string;
  card: CardPlacement;
}

/** A skin: a material effect over the whole companion (no art), one at a time. */
export interface SkinItem extends ItemBase {
  slot: "skin";
  skin: SkinEffect;
}

export type StoreItem = AccessoryItem | SkinItem;

export const isSkin = (i: StoreItem): i is SkinItem => i.slot === "skin";

export type PurchaseResult =
  | { ok: true; charged: number }
  /** Not enough tokens: an inline chip to /creditos, never a modal. */
  | { ok: false; reason: "no_tokens"; chipHref: string }
  /** The hub or the network failed: the same purchaseId may be retried (never charges twice). */
  | { ok: false; reason: "retry" }
  | { ok: false; reason: "failed" };

export type EquipResult = { ok: true } | { ok: false; reason: "not_owned" | "wrong_slot" | "no_companion" | "failed" };

export interface StoreApi {
  catalog(): Promise<StoreItem[] | "error">;
  purchase(cosmeticId: string, purchaseId: string): Promise<PurchaseResult>;
  equip(companionId: string, slot: Slot, cosmeticId: string | null): Promise<EquipResult>;
}

/** One per buy tap, reused on retries: 16–64 of [A-Za-z0-9_-]. */
export const newPurchaseId = (): string => `pur_${crypto.randomUUID().replaceAll("-", "")}`;

const SLOTS: readonly string[] = ["head", "face", "neck", "body", "back", "aura", "portal_fx", "skin"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const parseCatalog = (body: unknown): StoreItem[] | null => {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: StoreItem[] = [];
  for (const x of items as Record<string, unknown>[]) {
    const name = x?.name as { es?: unknown; en?: unknown } | undefined;
    const card = x?.card as { width?: unknown; neckWidth?: unknown; pivot?: unknown; anchorY?: unknown } | undefined;
    const pivot = Array.isArray(card?.pivot) ? (card.pivot as unknown[]) : [];
    if (
      typeof x?.id !== "string" ||
      !/^[a-z0-9_]{1,64}$/.test(x.id) ||
      typeof name?.es !== "string" ||
      typeof name.en !== "string" ||
      !SLOTS.includes(x.slot as string) ||
      typeof x.free !== "boolean" ||
      (!x.free && !(isNum(x.priceTokens) && x.priceTokens > 0)) ||
      typeof x.owned !== "boolean"
    )
      return null;
    const base = {
      id: x.id,
      name: { es: name.es, en: name.en },
      free: x.free,
      ...(x.free ? {} : { priceTokens: x.priceTokens as number }),
      owned: x.owned,
    };
    if (x.slot === "skin") {
      // A newer api may sell effects this build can't draw yet: skip those, keep the rest.
      if (!SKIN_EFFECTS.includes(x.skin as SkinEffect)) continue;
      out.push({ ...base, slot: "skin", skin: x.skin as SkinEffect });
      continue;
    }
    // Neck items are sized by the neck (`neckWidth`), the rest by the card (`width`); a back item may
    // hang from the neck (`anchorY: "neck"`).
    const neck = x.slot === "neck";
    if (
      typeof x.art !== "string" ||
      !/^cosmetics\/[a-z0-9_]+\.webp$/.test(x.art) ||
      !(neck ? isNum(card?.neckWidth) && card.neckWidth > 0 : isNum(card?.width) && card.width > 0) ||
      (card?.anchorY !== undefined && card.anchorY !== "neck") ||
      pivot.length !== 2 ||
      !pivot.every(isNum)
    )
      return null;
    const at: [number, number] = [pivot[0] as number, pivot[1] as number];
    out.push({
      ...base,
      slot: x.slot as AccessorySlot,
      art: x.art,
      card: neck
        ? { neckWidth: card!.neckWidth as number, pivot: at }
        : {
            width: card!.width as number,
            pivot: at,
            ...(card!.anchorY === "neck" ? { anchorY: "neck" as const } : {}),
          },
    });
  }
  return out;
};

/** The api's chip, if it's a same-site path; otherwise the credits page. */
const chipHref = (body: unknown): string => {
  const href = (body as { chips?: { href?: unknown }[] } | null)?.chips?.[0]?.href;
  return typeof href === "string" && /^\/(?![/\\])/.test(href) ? href : "/creditos";
};

export const httpStore = (
  base: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): StoreApi => {
  const call = async (path: string, body?: unknown): Promise<Response | null> => {
    const bearer = await token();
    if (!base || !bearer) return null;
    try {
      return await fetchImpl(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      });
    } catch {
      return null;
    }
  };
  const json = (r: Response) => r.json().catch(() => null) as Promise<unknown>;
  return {
    catalog: async () => {
      const r = await call("/v1/store/catalog");
      if (!r?.ok) return "error";
      return parseCatalog(await json(r)) ?? "error";
    },
    purchase: async (cosmeticId, purchaseId) => {
      const r = await call("/v1/store/purchase", { cosmeticId, purchaseId });
      if (!r || r.status >= 500 || r.status === 429) return { ok: false, reason: "retry" };
      const b = (await json(r)) as { status?: unknown; charged?: unknown; error?: unknown } | null;
      if (r.status === 402 && b?.error === "no_tokens")
        return { ok: false, reason: "no_tokens", chipHref: chipHref(b) };
      if (r.ok && b?.status === "owned") return { ok: true, charged: isNum(b.charged) ? b.charged : 0 };
      return { ok: false, reason: "failed" };
    },
    equip: async (companionId, slot, cosmeticId) => {
      const r = await call("/v1/store/equip", { companionId, slot, cosmeticId });
      if (r?.ok) return { ok: true };
      const e = r ? ((await json(r)) as { error?: unknown } | null)?.error : null;
      if (e === "not_owned" || e === "wrong_slot") return { ok: false, reason: e };
      if (e === "unknown_companion") return { ok: false, reason: "no_companion" };
      return { ok: false, reason: "failed" };
    },
  };
};

/** The person's companion as the store needs it (RLS read; `equipped` is written only by the api). */
export interface CompanionLook {
  companionId: string;
  avatar: string;
  equipped: Partial<Record<Slot, string>>;
}

type CompanionDb = {
  from(t: string): {
    select(c: string): {
      eq(
        c: string,
        v: unknown,
      ): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }> };
    };
  };
};

export const readCompanion = async (db: unknown, owner: string): Promise<CompanionLook | null | "error"> => {
  const { data, error } = await (db as CompanionDb)
    .from("companions")
    .select("companion_id,avatar,equipped")
    .eq("owner", owner)
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  const equipped: Partial<Record<Slot, string>> = {};
  for (const [k, v] of Object.entries((data.equipped as Record<string, unknown> | null) ?? {}))
    if (SLOTS.includes(k) && typeof v === "string") equipped[k as Slot] = v;
  return { companionId: String(data.companion_id), avatar: String(data.avatar ?? ""), equipped };
};
