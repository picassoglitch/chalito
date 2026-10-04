import type { EmotionTag } from "@chalito/protocol";

/**
 * The free roster (brief M8): six companions drawn as 2.5D image cards, generated with Google
 * AI Studio (provenance per asset in docs/ASSET_PROVENANCE.md). Rigged VRMs are out of scope for
 * the beta (D-059): the card avatar is the renderer path, driven by avatar-three's CreatureBinding.
 *
 * Each character has five drawings; the protocol's ten emotion tags map onto them.
 */
export const ROSTER_IDS = ["chalito", "bruno", "luna", "tito", "canela", "nube"] as const;
export type RosterId = (typeof ROSTER_IDS)[number];

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
  name: { es: string; en: string };
  /** Short description for onboarding cards. */
  blurb: { es: string; en: string };
  kind: "human" | "animal";
  /** Paths inside this package (assets/<id>/…), served by the apps as static files. */
  card: string;
  drawings: Record<Drawing, string>;
  thumbs: { 128: string; 256: string };
  license: "proprietary-generated";
}

const entry = (
  id: RosterId,
  kind: RosterEntry["kind"],
  name: RosterEntry["name"],
  blurb: RosterEntry["blurb"],
): RosterEntry => ({
  id,
  name,
  blurb,
  kind,
  card: `assets/${id}/card.json`,
  drawings: Object.fromEntries(DRAWINGS.map((d) => [d, `assets/${id}/layer-${d}.webp`])) as Record<Drawing, string>,
  thumbs: { 128: `assets/${id}/thumb-128.webp`, 256: `assets/${id}/thumb-256.webp` },
  license: "proprietary-generated",
});

export const ROSTER: readonly RosterEntry[] = [
  entry(
    "chalito",
    "human",
    { es: "Chalito", en: "Chalito" },
    { es: "Tu compañero de siempre.", en: "Your everyday companion." },
  ),
  entry(
    "bruno",
    "animal",
    { es: "Bruno", en: "Bruno" },
    { es: "Un osito tranquilo y paciente.", en: "A calm, patient bear." },
  ),
  entry("luna", "animal", { es: "Luna", en: "Luna" }, { es: "Una gatita curiosa.", en: "A curious kitten." }),
  entry(
    "tito",
    "animal",
    { es: "Tito", en: "Tito" },
    { es: "Un búho atento a todo.", en: "An owl who notices everything." },
  ),
  entry(
    "canela",
    "animal",
    { es: "Canela", en: "Canela" },
    { es: "Una zorrita lista y rápida.", en: "A quick, clever fox." },
  ),
  entry(
    "nube",
    "animal",
    { es: "Nube", en: "Nube" },
    { es: "Una conejita suave y alegre.", en: "A soft, cheerful bunny." },
  ),
];

export const rosterEntry = (id: string): RosterEntry | undefined => ROSTER.find((r) => r.id === id);

/** PWA/app icons cut from Chalito's card (D-057). Copy into apps/web/public. */
export const ICONS = {
  "icon-192.png": "icons/icon-192.png",
  "icon-512.png": "icons/icon-512.png",
  "icon-maskable-512.png": "icons/icon-maskable-512.png",
  "apple-touch-icon.png": "icons/apple-touch-icon.png",
  "favicon-32.png": "icons/favicon-32.png",
} as const;

export * from "./cosmetics.js";
