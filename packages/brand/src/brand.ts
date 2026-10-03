import type { Locale } from "@chalito/protocol";

export const PRODUCT_NAME = "Chalito";
/** Never translated. */
export const BOT_NAME = "Chalito Bot";

/** Credit suffix in the user's language (owner decision #11, D-028). */
export const CREDIT_SUFFIX: Readonly<Record<Locale, string>> = {
  en: `powered by ${BOT_NAME}`,
  es: `impulsado por ${BOT_NAME}`,
};

export const MAX_NAME_GRAPHEMES = 40;

// Control characters and bidi embedding/override/isolate controls: a custom name
// must not be able to reorder the credit line around it.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** First Strong Isolate / Pop Directional Isolate: keep an RTL name from flipping the suffix. */
const FSI = "⁨";
const PDI = "⁩";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Trims, strips unsafe characters, collapses whitespace and clamps to 40 graphemes (emoji-safe). */
export const sanitizeCompanionName = (raw: string): string => {
  const cleaned = raw.normalize("NFC").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  const graphemes = Array.from(segmenter.segment(cleaned), (s) => s.segment);
  return graphemes.slice(0, MAX_NAME_GRAPHEMES).join("").trim();
};

export interface CompanionTitle {
  /** What the companion is called on screen. */
  title: string;
  /** "<Name> · powered by Chalito Bot", or null for an un-renamed "Chalito". */
  credit: string | null;
}

/**
 * Un-renamed (or a name that sanitizes to nothing) → just "Chalito".
 * Renamed → the custom name plus the credit line in the user's language.
 */
export const formatCompanionTitle = (name: string, isRenamed: boolean, locale: Locale): CompanionTitle => {
  const clean = isRenamed ? sanitizeCompanionName(name) : "";
  if (!clean) return { title: PRODUCT_NAME, credit: null };
  return { title: clean, credit: `${FSI}${clean}${PDI} · ${CREDIT_SUFFIX[locale]}` };
};
