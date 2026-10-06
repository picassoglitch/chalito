import type { EmotionTag } from "@chalito/protocol";
import { CATALOG, CATEGORIES, type CatalogId, type Category } from "./catalog.js";

export { CATALOG, CATEGORIES, type CatalogEntry, type CatalogId, type Category } from "./catalog.js";

/**
 * The free roster: every catalog character (catalog.ts, 11 categories × 20), each drawn as a 2.5D
 * image card generated with Google AI Studio (provenance per asset in docs/ASSET_PROVENANCE.md).
 * All are free. Rigged VRMs are out of scope for the beta (D-059): the card avatar is the renderer
 * path, driven by avatar-three's CreatureBinding.
 *
 * Each character has five drawings; the protocol's ten emotion tags map onto them.
 */
export const ROSTER_IDS: readonly CatalogId[] = CATALOG.map((c) => c.id);
export type RosterId = CatalogId;

/** The six launch companions (M8), in their original order: the landing's showcase renders them. */
export const ORIGINAL_IDS = [
  "chalito",
  "bruno",
  "luna",
  "tito",
  "canela",
  "nube",
] as const satisfies readonly RosterId[];

/** Preselected at onboarding and used when the user taps "Saltar". */
export const DEFAULT_COMPANION: RosterId = "chalito";

export const DRAWINGS = ["neutral", "happy", "sad", "surprised", "tired"] as const;
export type Drawing = (typeof DRAWINGS)[number];

/** Every emotion tag shows one of the five drawings (the renderer adds motion on top). */
export const EMOTION_DRAWING: Record<EmotionTag, Drawing> = {
  neutral: "neutral",
  relaxed: "neutral",
  thinking: "neutral",
  happy: "happy",
  excited: "happy",
  sad: "sad",
  worried: "sad",
  angry: "sad",
  surprised: "surprised",
  tired: "tired",
};

export interface RosterEntry {
  id: RosterId;
  category: Category;
  name: { es: string; en: string };
  /** Short description for the picker and onboarding. */
  blurb: { es: string; en: string };
  /** Paths inside this package (assets/<id>/…), served by the apps as static files. */
  card: string;
  drawings: Record<Drawing, string>;
  thumbs: { 128: string; 256: string };
  license: "proprietary-generated";
}

export const ROSTER: readonly RosterEntry[] = CATALOG.map(({ id, category, name, blurb }): RosterEntry => ({
  id,
  category,
  name,
  blurb,
  card: `assets/${id}/card.json`,
  drawings: Object.fromEntries(DRAWINGS.map((d) => [d, `assets/${id}/layer-${d}.webp`])) as Record<Drawing, string>,
  thumbs: { 128: `assets/${id}/thumb-128.webp`, 256: `assets/${id}/thumb-256.webp` },
  license: "proprietary-generated",
}));

const BY_ID: ReadonlyMap<string, RosterEntry> = new Map(ROSTER.map((r) => [r.id, r]));

export const rosterEntry = (id: string): RosterEntry | undefined => BY_ID.get(id);

/** Whether a stored value (e.g. chalito.companions.avatar) is a roster id. */
export const isRosterId = (id: unknown): id is RosterId => typeof id === "string" && BY_ID.has(id);

/** The roster grouped by category, in CATEGORIES order (each group in catalog order). */
export const rosterByCategory = (): { category: Category; entries: RosterEntry[] }[] =>
  CATEGORIES.map(({ id }) => ({ category: id, entries: ROSTER.filter((r) => r.category === id) }));

/** Lowercase without accents, so "pina" finds "Piña". */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * Roster entries matching a search, by name in either language (accents and case ignored), within
 * one category or all of them.
 */
export const searchRoster = (query: string, category?: Category | null): RosterEntry[] => {
  const q = fold(query.trim());
  return ROSTER.filter(
    (r) =>
      (!category || r.category === category) &&
      (!q || fold(r.name.es).includes(q) || fold(r.name.en).includes(q) || r.id.includes(q)),
  );
};

/** PWA/app icons cut from Chalito's card (D-057). Copy into apps/web/public. */
export const ICONS = {
  "icon-192.png": "icons/icon-192.png",
  "icon-512.png": "icons/icon-512.png",
  "icon-maskable-512.png": "icons/icon-maskable-512.png",
  "apple-touch-icon.png": "icons/apple-touch-icon.png",
  "favicon-32.png": "icons/favicon-32.png",
} as const;

export * from "./cosmetics.js";
