import manifest from "../../public/showcase/manifest.json";

/** One real render from scripts/render-showcase.ts (public/showcase/manifest.json). */
export interface ShowcaseAsset {
  id: string;
  kind: "animated" | "still";
  /** Public path, e.g. "/showcase/hero-chalito.webp". */
  src: string;
  /** The still frame shown instead of the animation under reduced motion. */
  poster: string | null;
  w: number;
  h: number;
  alt: { es: string; en: string };
}

interface ManifestEntry {
  id: string;
  kind: string;
  file: string;
  poster?: string;
  w: number;
  h: number;
  alt: { es: string; en: string };
}

/** The ids `ids` asks for that `assets` doesn't have. */
export const missingShowcase = (ids: readonly string[], assets: readonly { id: string }[]): string[] =>
  ids.filter((id) => !assets.some((a) => a.id === id));

/**
 * A render by id. The landing calls this at module scope, so a reference to an asset that isn't
 * in the manifest throws while Next collects page data and fails the build.
 */
export const showcase = (id: string): ShowcaseAsset => {
  const a = (manifest.assets as ManifestEntry[]).find((x) => x.id === id);
  if (!a) throw new Error(`showcase asset "${id}" is not in public/showcase/manifest.json (pnpm render-showcase)`);
  return {
    id: a.id,
    kind: a.kind === "animated" ? "animated" : "still",
    src: `/${a.file}`,
    poster: a.poster ? `/${a.poster}` : null,
    w: a.w,
    h: a.h,
    alt: a.alt,
  };
};
