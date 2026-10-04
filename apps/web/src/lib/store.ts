import type { CardPlacement } from "@chalito/roster";

/**
 * The store (M8, docs/integrations/STORE.md): cosmetics change how a companion looks, never what
 * it can do. Prices are hub tokens, never money. Routes take the person's or this device's bearer.
 */
export type Slot = "head" | "face" | "body" | "back" | "aura" | "portal_fx";

export interface StoreItem {
  id: string;
  name: { es: string; en: string };
  slot: Slot;
  free: boolean;
  priceTokens?: number;
  /** A path inside @chalito/roster (cosmetics/<id>.webp). */
  art: string;
  card: CardPlacement;
  owned: boolean;
}

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

const SLOTS: readonly string[] = ["head", "face", "body", "back", "aura", "portal_fx"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const parseCatalog = (body: unknown): StoreItem[] | null => {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: StoreItem[] = [];
  for (const x of items as Record<string, unknown>[]) {
    const name = x?.name as { es?: unknown; en?: unknown } | undefined;
    const card = x?.card as { width?: unknown; pivot?: unknown } | undefined;
    const pivot = Array.isArray(card?.pivot) ? (card.pivot as unknown[]) : [];
    if (
      typeof x?.id !== "string" ||
      !/^[a-z0-9_]{1,64}$/.test(x.id) ||
      typeof name?.es !== "string" ||
      typeof name.en !== "string" ||
      !SLOTS.includes(x.slot as string) ||
      typeof x.free !== "boolean" ||
      (!x.free && !(isNum(x.priceTokens) && x.priceTokens > 0)) ||
      typeof x.art !== "string" ||
      !/^cosmetics\/[a-z0-9_]+\.webp$/.test(x.art) ||
      !isNum(card?.width) ||
      pivot.length !== 2 ||
      !pivot.every(isNum) ||
      typeof x.owned !== "boolean"
    )
      return null;
    out.push({
      id: x.id,
      name: { es: name.es, en: name.en },
      slot: x.slot as Slot,
      free: x.free,
      ...(x.free ? {} : { priceTokens: x.priceTokens as number }),
      art: x.art,
      card: { width: card!.width as number, pivot: [pivot[0] as number, pivot[1] as number] },
      owned: x.owned,
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
