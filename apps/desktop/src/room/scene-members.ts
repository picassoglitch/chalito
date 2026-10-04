import type { RoomMemberView } from "@chalito/rooms";
import type { CardPlacement } from "@chalito/roster";
import type { RoomSceneMember, SceneCosmetic } from "@chalito/scene";
import { COMPANIONS, DEFAULT_COMPANION } from "@chalito/ui";

type Rows = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
type Db = { from(t: string): { select(c: string): { eq(c: string, v: unknown): Rows } } };

/** The store catalog's placement data for each cosmetic id (GET /v1/store/catalog). */
export type CosmeticCatalog = ReadonlyMap<string, SceneCosmetic>;

const card = (v: unknown) => ((COMPANIONS as readonly string[]).includes(String(v)) ? String(v) : DEFAULT_COMPANION);

/**
 * The catalog, fetched once per window and kept (it's static per release). A failure leaves an
 * empty catalog for this attempt and retries next time: members still render, without cosmetics.
 */
export const catalogLoader = (fetchItems: () => Promise<unknown>) => {
  let cached: Promise<CosmeticCatalog> | null = null;
  return (): Promise<CosmeticCatalog> =>
    (cached ??= fetchItems().then(
      (body) => {
        const items = (body as { items?: unknown } | null)?.items;
        const out = new Map<string, SceneCosmetic>();
        for (const it of Array.isArray(items) ? items : []) {
          const x = it as { id?: unknown; slot?: unknown; art?: unknown; card?: CardPlacement };
          if (typeof x.id === "string" && typeof x.slot === "string" && typeof x.art === "string" && x.card)
            out.set(x.id, { slot: x.slot as SceneCosmetic["slot"], art: x.art, card: x.card });
        }
        return out;
      },
      () => {
        cached = null;
        return new Map();
      },
    ));
};

/**
 * Room members as the scene draws them, from companion_directory (what co-members may see of each
 * other; server-written, kept in step by a trigger on companions): the roster card (an unknown or
 * missing one is the default companion) and the equipped cosmetics, placed from the catalog. Ids
 * the catalog doesn't know are dropped.
 */
export const sceneMembersFor = async (
  db: unknown,
  members: readonly RoomMemberView[],
  catalog: () => Promise<CosmeticCatalog> = async () => new Map(),
): Promise<RoomSceneMember[]> => {
  const d = db as Db;
  const items = await catalog();
  const out: RoomSceneMember[] = [];
  for (const m of members) {
    const { data } = await d
      .from("companion_directory")
      .select("companion_id, avatar_thumb, equipped")
      .eq("companion_id", m.companionId);
    const row = data?.[0];
    const equipped = Array.isArray(row?.equipped) ? (row.equipped as unknown[]) : [];
    const cosmetics = equipped.flatMap((id) => {
      const c = typeof id === "string" ? items.get(id) : undefined;
      return c ? [c] : [];
    });
    out.push({
      companionId: m.companionId,
      avatar: card(row?.avatar_thumb),
      presence: "online",
      ...(cosmetics.length ? { cosmetics } : {}),
    });
  }
  return out;
};
