/**
 * DEV/TEST ONLY: the store catalog the mock api serves, mirroring packages/config/catalog.yaml
 * (test/store.test.ts keeps the two in step). Prices are hub tokens.
 */
export const DEV_CATALOG = {
  viking_hat: {
    name: { es: "Casco vikingo", en: "Viking helmet" },
    slot: "head",
    free: true,
    art: "cosmetics/viking_hat.webp",
    card: { width: 0.5, pivot: [0.5, 0.95] },
  },
  flower_crown: {
    name: { es: "Corona de flores", en: "Flower crown" },
    slot: "head",
    free: true,
    art: "cosmetics/flower_crown.webp",
    card: { width: 0.44, pivot: [0.5, 0.62] },
  },
  round_glasses: {
    name: { es: "Lentes redondos", en: "Round glasses" },
    slot: "face",
    free: true,
    art: "cosmetics/round_glasses.webp",
    card: { width: 0.36, pivot: [0.5, 0.5] },
  },
  star_cape: {
    name: { es: "Capa de estrellas", en: "Star cape" },
    slot: "back",
    free: false,
    priceTokens: 250000,
    art: "cosmetics/star_cape.webp",
    card: { width: 0.72, pivot: [0.5, 0.12] },
  },
  sparkle_aura: {
    name: { es: "Aura brillante", en: "Sparkle aura" },
    slot: "aura",
    free: false,
    priceTokens: 150000,
    art: "cosmetics/sparkle_aura.webp",
    card: { width: 1.1, pivot: [0.5, 0.5] },
  },
  portal_swirl: {
    name: { es: "Portal giratorio", en: "Swirl portal" },
    slot: "portal_fx",
    free: false,
    priceTokens: 400000,
    art: "cosmetics/portal_swirl.webp",
    card: { width: 1.0, pivot: [0.5, 0.5] },
  },
} as const satisfies Record<
  string,
  {
    name: { es: string; en: string };
    slot: string;
    free: boolean;
    priceTokens?: number;
    art: string;
    card: { width: number; pivot: readonly [number, number] };
  }
>;
